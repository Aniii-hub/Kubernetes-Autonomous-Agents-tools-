#!/usr/bin/env python3
"""
Kubernetes Self-Healing Agent.
Monitors cluster workloads, detects scheduling/pending hangs (e.g. PV mounts, resource limits),
analyzes upstream database/cache dependencies (e.g. Redis), and takes automated healing actions.
"""

import os
import sys
import time
import yaml
import logging
from datetime import datetime, timezone
from collections import defaultdict

# Import Kubernetes client
try:
    # pyrefly: ignore [missing-import]
    from kubernetes import client, config
    # pyrefly: ignore [missing-import]
    from kubernetes.client.rest import ApiException
    K8S_AVAILABLE = True
except ImportError:
    K8S_AVAILABLE = False

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("self-healing-agent")

class K8sSelfHealingAgent:
    def __init__(self, config_path: str):
        self.config_path = config_path
        self.config_data = self.load_config()
        self.restart_history = defaultdict(list)  # pod_name -> [timestamps]
        
        # Set logging level
        log_level = self.config_data.get("log_level", "INFO").upper()
        logger.setLevel(getattr(logging, log_level, logging.INFO))
        
        self.dry_run = self.config_data.get("dry_run", True)
        if self.dry_run:
            logger.info("⚡ RUNNING IN DRY-RUN MODE: No resources will be mutated/deleted.")
            
        self.init_k8s_client()

    def load_config(self) -> dict:
        """Load YAML configuration."""
        try:
            with open(self.config_path, 'r') as f:
                return yaml.safe_load(f)
        except Exception as e:
            logger.error(f"Failed to load config from {self.config_path}: {e}")
            # Safe default fallback
            return {
                "watch_namespaces": ["dev"],
                "check_interval_seconds": 30,
                "dry_run": True,
                "log_level": "INFO",
                "healing_policies": {
                    "pending_state": {
                        "max_pending_minutes": 5,
                        "restart_on_volume_attachment_stuck": True,
                        "alert_on_insufficient_resources": True
                    },
                    "crashloop_state": {
                        "restart_after_dependency_recovered": True,
                        "max_healing_restarts_per_pod_hour": 3
                    }
                }
            }

    def init_k8s_client(self):
        """Initialize Kubernetes API client."""
        if not K8S_AVAILABLE:
            logger.warning("Kubernetes Python client library not installed. Running in SIMULATION MODE.")
            self.k8s_enabled = False
            return

        try:
            # First attempt: load in-cluster config (if running inside a pod)
            config.load_incluster_config()
            logger.info("Successfully loaded in-cluster Kubernetes configuration.")
            self.k8s_enabled = True
        except config.config_exception.ConfigException:
            try:
                # Second attempt: load local kubeconfig (for local debugging/testing)
                config.load_kube_config()
                logger.info("Successfully loaded local Kubeconfig.")
                self.k8s_enabled = True
            except Exception as e:
                logger.warning(f"Could not load Kubeconfig: {e}. Running in SIMULATION MODE.")
                self.k8s_enabled = False

        if self.k8s_enabled:
            self.v1 = client.CoreV1Api()
            self.events_v1 = client.EventsV1Api()
        else:
            self.v1 = None

    def get_pods(self, namespace: str) -> list:
        """Fetch list of all pods in a namespace (or mock data if in simulation mode)."""
        if not self.k8s_enabled:
            return self.get_simulated_pods(namespace)

        try:
            pod_list = self.v1.list_namespaced_pod(namespace)
            return pod_list.items
        except ApiException as e:
            logger.error(f"Kubernetes API error listing pods in {namespace}: {e}")
            return []

    def get_simulated_pods(self, namespace: str) -> list:
        """Generate simulated pods to demonstrate how the agent handles issues."""
        class MockContainerStatus:
            def __init__(self, name, ready, restart_count, state_name, reason=None):
                self.name = name
                self.ready = ready
                self.restart_count = restart_count
                self.state = type('obj', (object,), {
                    'waiting': type('obj', (object,), {'reason': reason})() if state_name == 'waiting' else None,
                    'running': type('obj', (object,), {})() if state_name == 'running' else None,
                    'terminated': type('obj', (object,), {'reason': reason})() if state_name == 'terminated' else None,
                })()

        class MockPodStatus:
            def __init__(self, phase, container_statuses=None, start_time=None):
                self.phase = phase
                self.container_statuses = container_statuses or []
                self.start_time = start_time or datetime.now(timezone.utc)

        class MockPodMetadata:
            def __init__(self, name, namespace, creation_timestamp=None):
                self.name = name
                self.namespace = namespace
                self.creation_timestamp = creation_timestamp or datetime.now(timezone.utc)

        class MockPod:
            def __init__(self, name, namespace, phase, container_statuses=None, creation_timestamp=None):
                self.metadata = MockPodMetadata(name, namespace, creation_timestamp)
                self.status = MockPodStatus(phase, container_statuses, creation_timestamp)

        # Simulated timestamps (10 minutes ago to exceed 5-minute thresholds)
        old_timestamp = datetime.fromtimestamp(time.time() - 600, timezone.utc)

        # Build mock workloads mimicking a typical morning startup issue
        # Redis container has successfully started and is healthy
        redis_pod = MockPod(
            name="redis-master-0",
            namespace=namespace,
            phase="Running",
            container_statuses=[MockContainerStatus("redis", True, 0, "running")],
            creation_timestamp=old_timestamp
        )
        
        # Clinical RAG Service stuck in CrashLoop (restarts: 5)
        # It relies on Redis, which is now healthy, so it should trigger a healing prompt
        rag_pod = MockPod(
            name="clinical-rag-service-5c8bd456-abcde",
            namespace=namespace,
            phase="Running",
            container_statuses=[MockContainerStatus("clinical-rag-service", False, 5, "waiting", "CrashLoopBackOff")],
            creation_timestamp=old_timestamp
        )

        # Healthcare Backend Service pending due to volume mount issue (stuck PV attachment)
        # It has been pending for 10 minutes, so it should trigger a healing prompt
        backend_pod = MockPod(
            name="healthcare-backend-677bd1d-fghij",
            namespace=namespace,
            phase="Pending",
            container_statuses=[MockContainerStatus("healthcare-backend", False, 0, "waiting", "ContainerCreating")],
            creation_timestamp=old_timestamp
        )

        return [redis_pod, rag_pod, backend_pod]

    def get_pod_events(self, pod) -> list:
        """Fetch events associated with a pod to diagnose Pending state."""
        if not self.k8s_enabled:
            # Simulated events for our mock pods
            if "backend" in pod.metadata.name:
                return [{"reason": "FailedMount", "message": "Unable to attach or mount volumes: volume-attach-timeout for pv-dgcare-dev"}]
            if "redis" in pod.metadata.name:
                return [{"reason": "FailedScheduling", "message": "0/3 nodes are available: 3 Insufficient cpu."}]
            return []

        try:
            events = self.v1.list_namespaced_event(
                namespace=pod.metadata.namespace,
                field_selector=f"involvedObject.name={pod.metadata.name}"
            )
            return [{"reason": e.reason, "message": e.message} for e in events.items]
        except ApiException as e:
            logger.error(f"Error fetching events for pod {pod.metadata.name}: {e}")
            return []

    def get_pod_logs(self, pod) -> str:
        """Fetch logs of a crashlooping pod to diagnose dependency connection issues."""
        if not self.k8s_enabled:
            # Simulate connection error logs for RAG pod
            if "rag-service" in pod.metadata.name:
                return "Connecting to Redis at redis-master:6379...\nError: Connection refused. Retrying...\nFatal: Could not connect to Redis server."
            return ""

        try:
            # Get last 20 lines of log
            logs = self.v1.read_namespaced_pod_log(
                name=pod.metadata.name,
                namespace=pod.metadata.namespace,
                tail_lines=20
            )
            return logs
        except ApiException as e:
            logger.debug(f"Could not read logs for pod {pod.metadata.name}: {e}")
            return ""

    def explain_failure_with_llama3(self, pod_name: str, logs: str, events: list) -> str:
        """Call LiteLLM endpoint to explain the pod failure using Llama 3."""
        # Check if we should return simulated mock explanation (to facilitate test run)
        if not self.k8s_enabled:
            if "rag-service" in pod_name:
                return (
                    "🤖 [Llama 3 Diagnostic Analysis]\n"
                    "The pod 'clinical-rag-service' is crashlooping because it cannot establish a connection "
                    "to the Redis service at port 6379 (Connection Refused). The upstream Redis dependency is now healthy, "
                    "so restarting this pod immediately will resolve the crash loop."
                )
            elif "backend" in pod_name:
                return (
                    "🤖 [Llama 3 Diagnostic Analysis]\n"
                    "The pod 'healthcare-backend' is stuck in Pending because it is waiting for a Persistent Volume "
                    "attachment timeout. Deleting this pod will force Kubernetes to re-request the EBS volume mount "
                    "on the newly active node."
                )
            return "🤖 [Llama 3 Diagnostic Analysis]\nTransient environment scaling issue detected. Re-scheduling is recommended."

        # Real Llama 3 analysis
        cfg = self.config_data.get("litellm", {})
        url = cfg.get("url", "")
        api_key = cfg.get("api_key", "")
        model = cfg.get("model", "llm-heavy")
        
        if not url or not api_key:
            return ""

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        # Prepare context payload
        import json
        events_str = json.dumps(events, indent=2) if events else "No recent Kubernetes event logs."
        logs_str = logs[-1500:] if logs else "No pod application logs available."
        
        prompt = (
            f"You are K8s-Self-Healing-Assistant. Analyze this Kubernetes pod failure and suggest a resolution:\n\n"
            f"Pod Name: {pod_name}\n"
            f"Recent Events:\n{events_str}\n"
            f"Container Logs Tail:\n{logs_str}\n\n"
            "Explain: 1. The exact root cause. 2. The recommended action. Keep your answer brief and clear (max 3 sentences)."
        )
        
        payload = {
            "model": model,
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.2,
            "max_tokens": 150
        }
        
        try:
            import requests
            resp = requests.post(f"{url.rstrip('/')}/v1/chat/completions", json=payload, headers=headers, timeout=15)
            resp.raise_for_status()
            ai_msg = resp.json()["choices"][0]["message"]["content"]
            return f"🤖 [Llama 3 Diagnostic Analysis]\n{ai_msg.strip()}"
        except Exception as e:
            logger.debug(f"Failed to fetch Llama 3 diagnosis: {e}")
            return ""

    def delete_pod(self, name: str, namespace: str, logs: str = "", events: list = None) -> bool:
        """Delete a pod to trigger a restart/re-schedule, checking for user approval if configured."""
        interactive = self.config_data.get("interactive_approval", True)
        if interactive:
            # Fetch Llama 3 analysis
            explanation = self.explain_failure_with_llama3(name, logs, events)
            if explanation:
                print(f"\n{explanation}")
            
            print(f"❓ [APPROVAL REQUESTED] Approve deletion/restart of pod '{name}' in namespace '{namespace}'? [y/N]: ", end="", flush=True)
            try:
                choice = input().strip().lower()
                if choice not in ("y", "yes"):
                    logger.info(f"❌ Healing action rejected by user for pod: {name}")
                    return False
                logger.info("✅ Action approved by user.")
            except Exception as e:
                logger.warning(f"Could not prompt user ({e}). Skipping healing action for safety.")
                return False

        logger.info(f"🚨 HEALING ACTION: Deleting pod {name} in namespace {namespace}...")
        if self.dry_run:
            logger.info(f" Dry-run active. Did not delete pod {name}.")
            return True

        if not self.k8s_enabled:
            logger.info(f" Simulation: Pod {name} deleted.")
            return True

        try:
            self.v1.delete_namespaced_pod(name=name, namespace=namespace)
            logger.info(f"✅ Successfully deleted pod {name} to trigger restart.")
            return True
        except ApiException as e:
            logger.error(f"Failed to delete pod {name} in {namespace}: {e}")
            return False

    def can_restart(self, pod_name: str) -> bool:
        """Enforce rate limits on restarts to prevent infinite loops."""
        max_restarts = self.config_data.get("healing_policies", {})\
            .get("crashloop_state", {})\
            .get("max_healing_restarts_per_pod_hour", 3)
            
        now = time.time()
        # Clean older timestamps (older than 1 hour)
        self.restart_history[pod_name] = [t for t in self.restart_history[pod_name] if now - t < 3600]
        
        if len(self.restart_history[pod_name]) >= max_restarts:
            logger.warning(f"⚠️ Rate limit hit: Pod {pod_name} has been restarted {max_restarts} times in the last hour. Skipping.")
            return False
            
        return True

    def record_restart(self, pod_name: str):
        """Record restart timestamp for rate limiting."""
        self.restart_history[pod_name].append(time.time())

    def analyze_and_heal(self):
        """Core analysis and self-healing execution loop."""
        logger.info("🔍 Starting cluster health diagnostic check...")
        
        namespaces = self.config_data.get("watch_namespaces", ["dev"])
        policies = self.config_data.get("healing_policies", {})
        
        # Track core upstream service statuses across the watched namespaces
        # e.g., {"redis": "healthy" | "pending" | "crashloop"}
        core_services = {}

        # First Pass: Inventory core services and identify their health status
        for ns in namespaces:
            pods = self.get_pods(ns)
            for pod in pods:
                name = pod.metadata.name
                
                # Check if it's an upstream service we track
                for chain in self.config_data.get("dependency_chains", []):
                    upstream_pat = chain["upstream"]["name_pattern"]
                    upstream_ns = chain["upstream"]["namespace"]
                    
                    if upstream_ns == ns and upstream_pat in name:
                        # Determine status
                        status = "healthy"
                        if pod.status.phase == "Pending":
                            status = "pending"
                        else:
                            for c_status in pod.status.container_statuses:
                                if not c_status.ready:
                                    status = "unhealthy"
                                    if c_status.state.waiting and c_status.state.waiting.reason in ("CrashLoopBackOff", "Error"):
                                        status = "crashloop"
                        
                        core_services[upstream_pat] = status
                        logger.info(f"📍 Upstream service tracked: {name} status is {status.upper()}")

        # Second Pass: Process all workloads and apply healing policies
        for ns in namespaces:
            pods = self.get_pods(ns)
            for pod in pods:
                name = pod.metadata.name
                phase = pod.status.phase
                
                # Calculate age in minutes
                creation_time = pod.metadata.creation_timestamp
                age_minutes = (datetime.now(timezone.utc) - creation_time).total_seconds() / 60.0
                
                # ── CASE 1: Pod is stuck in PENDING ──
                if phase == "Pending":
                    max_pending = policies.get("pending_state", {}).get("max_pending_minutes", 5)
                    if age_minutes >= max_pending:
                        logger.warning(f"⏳ Pod {name} has been PENDING for {age_minutes:.1f} minutes (Threshold: {max_pending}m)")
                        
                        # Diagnose via events
                        events = self.get_pod_events(pod)
                        for ev in events:
                            logger.info(f"   [Pod Event] Reason: {ev['reason']} | Message: {ev['message']}")
                            
                            # Subcase A: Volume attachment stuck
                            if ev['reason'] in ("FailedMount", "FailedAttachVolume"):
                                if policies.get("pending_state", {}).get("restart_on_volume_attachment_stuck", True):
                                    logger.info(f"   👉 Diagnosis: Stuck PV attachment / Mount timeout.")
                                    if self.can_restart(name):
                                        if self.delete_pod(name, ns, events=events):
                                            self.record_restart(name)
                                            break
                            
                            # Subcase B: Resource limits exceeded
                            elif ev['reason'] == "FailedScheduling" and "Insufficient" in ev['message']:
                                logger.error(f"   ❌ Diagnosis: Resource capacity limit hit ({ev['message']}). Node scale-up required!")
                
                # ── CASE 2: Pod is in CRASHLOOP or failing probes ──
                elif phase == "Running":
                    for c_status in pod.status.container_statuses:
                        if not c_status.ready:
                            state_reason = c_status.state.waiting.reason if c_status.state.waiting else None
                            
                            if state_reason == "CrashLoopBackOff":
                                logger.warning(f"💥 Pod {name} is in CRASHLOOPBACKOFF (restarts: {c_status.restart_count})")
                                
                                # Analyze logs for connection errors
                                logs = self.get_pod_logs(pod)
                                is_conn_failure = any(keyword in logs.lower() for keyword in [
                                    "connection refused", "could not connect", "redis connection", 
                                    "database connection", "dial tcp", "timeout"
                                ])
                                
                                if is_conn_failure:
                                    logger.info("   👉 Diagnosis: Connection refusal in application startup logs.")
                                    
                                    # Check if this service depends on an upstream model
                                    for chain in self.config_data.get("dependency_chains", []):
                                        downstream_pat = chain["downstream"]["name_pattern"]
                                        upstream_pat = chain["upstream"]["name_pattern"]
                                        
                                        if downstream_pat in name:
                                            upstream_status = core_services.get(upstream_pat, "unknown")
                                            logger.info(f"   🔗 Dependancy Link: {name} relies on {upstream_pat} (Status: {upstream_status.upper()})")
                                            
                                            # If the upstream dependency has recovered (is now healthy),
                                            # but the downstream pod is stuck in a long CrashLoop back-off delay,
                                            # delete the downstream pod to force an immediate, clean restart.
                                            if upstream_status == "healthy" and policies.get("crashloop_state", {}).get("restart_after_dependency_recovered", True):
                                                logger.info(f"   🚀 Upstream {upstream_pat} is healthy! Bypassing CrashLoop back-off delay.")
                                                if self.can_restart(name):
                                                    if self.delete_pod(name, ns, logs=logs):
                                                        self.record_restart(name)
                                                        break

        logger.info("✅ Health diagnostic pass completed.")

    def run_forever(self):
        """Run the agent loop continuously."""
        interval = self.config_data.get("check_interval_seconds", 30)
        logger.info(f"Starting self-healing loop. Check interval: {interval}s")
        try:
            while True:
                self.analyze_and_heal()
                time.sleep(interval)
        except KeyboardInterrupt:
            logger.info("Shutting down self-healing agent.")

if __name__ == "__main__":
    # Locate configuration file relative to the script location
    script_dir = os.path.dirname(os.path.abspath(__file__))
    config_file = os.path.join(script_dir, "config.yaml")
    
    agent = K8sSelfHealingAgent(config_file)
    # Perform a single diagnostic run by default (or run_forever if daemonized)
    agent.analyze_and_heal()

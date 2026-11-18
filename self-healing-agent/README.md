# Kubernetes Self-Healing Agent 🩺

Automated self-healing daemon for Kubernetes/EKS dev clusters. 

## The Problem
In development clusters (like `dgcare-dev`), EKS nodes are often scaled down to `0` or stopped overnight to save costs. When instances boot back up in the morning, several transient startup issues occur:
1. **PV Mounting Delays**: Persistent Volumes (like EBS) can take several minutes to detach from old terminated nodes and attach to new ones, leaving dependent database/cache pods (like Redis) stuck in the `Pending` state.
2. **Exponential CrashLoopBackOff Delays**: Dependent application services (like `clinical-rag-service` or backend microservices) start up first. Because Redis or database endpoints are not yet online, they fail connection tests and enter a `CrashLoopBackOff` state. Kubernetes' exponential back-off delay increases up to **5 minutes** between restarts. Even *after* Redis becomes healthy, these services remain stuck sleeping in back-off mode, delaying environment readiness.

## How the Agent Solves It
The self-healing agent runs continuously and performs the following actions:
1. **Volume Attachment Recovery**: Scans for pods stuck in the `Pending` state for more than 5 minutes. If it detects `FailedMount` or `FailedAttachVolume` events, it deletes the pod to force Kubernetes to retry the volume mapping.
2. **Dependency-Aware CrashLoop Bypassing**: Scans for pods in `CrashLoopBackOff`. If it detects connection failure messages in the logs:
   - It checks the health status of the upstream dependencies (e.g., `redis`) defined in `config.yaml`.
   - If the upstream dependency has since become healthy, it deletes the downstream pod to **bypass the exponential back-off timer**, forcing it to boot immediately.
3. **Capacity Warnings**: Identifies pods stuck in `Pending` due to `Insufficient cpu` or `Insufficient memory` and logs EKS cluster capacity limits.

---

## File Structure
* `config.yaml`: Watch namespaces, dependency definitions, and healing limits.
* `agent.py`: Core logic executing Kubernetes API probes and restarts.

---

## Configuration (`config.yaml`)
Define your watch target namespaces and dependency maps:

```yaml
watch_namespaces:
  - dev

check_interval_seconds: 30

dependency_chains:
  - upstream:
      name_pattern: "redis" # Name query matches Redis pods
      namespace: "dev"
    downstream:
      name_pattern: "-service" # Matches clinical-rag-service, chat-service, etc.
      namespace: "dev"
      auto_restart_on_upstream_recovery: true

healing_policies:
  pending_state:
    max_pending_minutes: 5
    restart_on_volume_attachment_stuck: true
  crashloop_state:
    restart_after_dependency_recovered: true
    max_healing_restarts_per_pod_hour: 3

interactive_approval: true # Set to true to prompt user in terminal before deleting any resources
dry_run: true # Set to false to allow mutating/deleting pods
```


---

## How to Run

### 1. Locally (with kubectl permissions)
To run the agent locally against your active Kubernetes context:

```bash
# Install dependencies
pip install kubernetes PyYAML

# Run the agent in Dry-Run mode to verify diagnoses
python tools/self-healing-agent/agent.py
```

### 2. Deploying as a Pod in the Cluster
You can deploy this directly in your EKS cluster with a ServiceAccount that has RBAC permissions to `get`, `list`, and `delete` pods.

Example `deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: self-healing-agent
  namespace: flux-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: self-healing-agent
  template:
    metadata:
      labels:
        app: self-healing-agent
    spec:
      serviceAccountName: self-healing-agent-sa
      containers:
        - name: agent
          image: python:3.9-slim
          command: ["python", "/app/agent.py"]
          volumeMounts:
            - name: config-volume
              mountPath: /app
      volumes:
        - name: config-volume
          configMap:
            name: self-healing-agent-config
```

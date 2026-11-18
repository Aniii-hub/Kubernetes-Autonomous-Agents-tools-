"""
FinOps Analyzer — correlates AWS inventory + Prometheus metrics
and generates structured recommendations.
"""

import datetime
from rich.console import Console

console = Console()

# On-Demand pricing for ap-south-1 (USD/hr) — approximate
INSTANCE_PRICING = {
    "t3.micro": 0.0116, "t3.small": 0.0232, "t3.medium": 0.0464,
    "t3.large": 0.0928, "t3.xlarge": 0.1856, "t3.2xlarge": 0.3712,
    "m5.large": 0.107,  "m5.xlarge": 0.214,  "m5.2xlarge": 0.428,
    "m5.4xlarge": 0.856, "m6i.large": 0.1008, "m6i.xlarge": 0.2016,
    "m6i.2xlarge": 0.4032, "c5.large": 0.085, "c5.xlarge": 0.17,
    "c5.2xlarge": 0.34, "r5.large": 0.141, "r5.xlarge": 0.282,
    "t3a.medium": 0.0418, "t3a.large": 0.0835, "t3a.xlarge": 0.167,
}

# Downsize map: for each instance type, suggest the next size down
DOWNSIZE_MAP = {
    "t3.2xlarge": "t3.xlarge", "t3.xlarge": "t3.large",
    "t3.large": "t3.medium",   "t3.medium": "t3.small",
    "m5.4xlarge": "m5.2xlarge","m5.2xlarge": "m5.xlarge",
    "m5.xlarge": "m5.large",   "m6i.2xlarge": "m6i.xlarge",
    "m6i.xlarge": "m6i.large", "c5.2xlarge": "c5.xlarge",
    "c5.xlarge": "c5.large",   "r5.xlarge": "r5.large",
}

EBS_GP3_PRICE_PER_GB = 0.096   # USD/GB/month in ap-south-1
EBS_GP2_PRICE_PER_GB = 0.114
SNAPSHOT_PRICE_PER_GB = 0.054
ALB_PRICE_PER_HOUR = 0.022     # base charge only


def _parse_metric_map(series: list, key_labels=("pod", "namespace")) -> dict:
    """Convert Prometheus result list to dict keyed by (pod, namespace)."""
    result = {}
    for item in (series or []):
        labels = item.get("metric", {})
        key = tuple(labels.get(k, "") for k in key_labels)
        value = item.get("value", [None, "0"])
        try:
            result[key] = float(value[1])
        except (IndexError, ValueError, TypeError):
            result[key] = 0.0
    return result


class FinOpsAnalyzer:
    def __init__(self, config: dict, aws_data: dict, grafana_data: dict):
        self.cfg = config
        self.aws = aws_data
        self.metrics = grafana_data.get("metrics", {})
        self.idle_threshold = config["analysis"]["idle_cpu_threshold_pct"] / 100.0
        self.rs_threshold = config["analysis"]["rightsizing_cpu_threshold_pct"] / 100.0
        self.findings = []
        self.total_savings = 0.0
        self.total_cluster_cost = 0.0
        self.total_aws_cost = 0.0

    def analyze(self) -> dict:
        console.print("[bold cyan]🧠 Running FinOps analysis...[/bold cyan]")
        self._analyze_ebs_hygiene()
        self._analyze_snapshots()
        self._analyze_load_balancers()
        self._analyze_eks_nodes()
        self._analyze_standalone_ec2()
        self._analyze_pod_rightsizing()
        self._analyze_scale_to_zero()
        self._analyze_s3()
        self._analyze_cloudfront()
        self._analyze_iam()
        self._analyze_eks_control_plane()
        self._analyze_loki_logs()
        self._sort_findings()
        self._calculate_total_costs()
        console.print(
            f"[green]✅ Analysis complete.[/green] "
            f"[bold]{len(self.findings)} findings[/bold], "
            f"estimated savings: [bold green]${self.total_savings:,.2f}/month[/bold green]"
        )
        cluster_plans = self._build_cluster_plans()
        return {
            "findings": self.findings,
            "total_savings": round(self.total_savings, 2),
            "total_cluster_cost": round(self.total_cluster_cost, 2),
            "total_aws_cost": round(self.total_aws_cost, 2),
            "cluster_plans": cluster_plans,
            "analyzed_at": datetime.datetime.utcnow().isoformat(),
        }

    def _build_cluster_plans(self) -> list:
        """Build a per-cluster 3-phase optimization plan from real findings + metrics."""
        ci = self.aws.get("container_insights", {})
        pod_cpu_avg  = {(p["cluster"], p["pod"]): p["value"] for p in ci.get("pod_cpu_avg", [])}
        pod_cpu_req  = {(p["cluster"], p["pod"]): p["value"] for p in ci.get("pod_cpu_request", [])}
        pod_mem_avg  = {(p["cluster"], p["pod"]): p["value"] for p in ci.get("pod_mem_avg", [])}
        pod_mem_req  = {(p["cluster"], p["pod"]): p["value"] for p in ci.get("pod_mem_request", [])}

        # Group pod right-sizing findings by cluster
        rs_by_cluster = {}
        sz_by_cluster = {}
        for f in self.findings:
            if f["category"] == "Pod Right-sizing":
                rid = f["resource_id"]  # e.g. "prod/relay"
                parts = rid.split("/")
                ns = parts[0] if parts else ""
                # Find which cluster this namespace belongs to
                for cluster_info in self.aws.get("eks_clusters", []):
                    cname = cluster_info["cluster"]["name"]
                    # Match by namespace prefixes
                    if (("prod" in cname and ns in ("prod", "backup", "monitoring")) or
                        ("qa" in cname and ns in ("qa", "sit")) or
                        ("uat" in cname and ns in ("uat",)) or
                        ("dev" in cname and ns in ("dev", "kserve", "litellm"))):
                        rs_by_cluster.setdefault(cname, []).append(f)
                        break
            elif f["category"] == "Scale-to-Zero Candidate":
                rid = f["resource_id"]
                parts = rid.split("/")
                ns = parts[0] if parts else ""
                for cluster_info in self.aws.get("eks_clusters", []):
                    cname = cluster_info["cluster"]["name"]
                    if (("prod" in cname and ns in ("prod", "backup", "monitoring")) or
                        ("qa" in cname and ns in ("qa", "sit")) or
                        ("uat" in cname and ns in ("uat",)) or
                        ("dev" in cname and ns in ("dev", "kserve", "litellm"))):
                        sz_by_cluster.setdefault(cname, []).append(f)
                        break

        plans = []
        for cluster_info in self.aws.get("eks_clusters", []):
            cname = cluster_info["cluster"]["name"]
            ngs = cluster_info.get("nodegroups", [])
            rs_findings = rs_by_cluster.get(cname, [])
            sz_findings = sz_by_cluster.get(cname, [])

            # Cluster cost
            ctrl_cost = 73.0
            node_cost = sum(
                INSTANCE_PRICING.get(ng.get("instanceTypes", [""])[0], 0) * 730 *
                ng.get("scalingConfig", {}).get("desiredSize", 0)
                for ng in ngs
            )
            total_cluster_monthly = ctrl_cost + node_cost

            # Phase 1: reduce pod resources
            phase1_items = []
            for f in rs_findings[:6]:
                phase1_items.append(f["suggested_action"])

            # Phase 2: scale-to-zero candidates  
            phase2_items = []
            for f in sz_findings[:4]:
                phase2_items.append(f"Schedule '{f['name']}' to scale-to-zero at night (KEDA CronScaler)")

            # Phase 3: node rightsizing / removal
            phase3_items = []
            for ng in ngs:
                inst = ng.get("instanceTypes", ["unknown"])[0]
                desired = ng.get("scalingConfig", {}).get("desiredSize", 0)
                smaller = DOWNSIZE_MAP.get(inst)
                if smaller:
                    save = (INSTANCE_PRICING.get(inst, 0) - INSTANCE_PRICING.get(smaller, 0)) * 730 * desired
                    phase3_items.append(
                        f"Downsize '{ng['nodegroupName']}' from {inst} → {smaller} "
                        f"(x{desired} nodes, saves ~${save:.0f}/mo)"
                    )
                else:
                    phase3_items.append(
                        f"Node group '{ng['nodegroupName']}' ({inst} x{desired}) — "
                        f"review after pod resources are reduced."
                    )

            if not phase3_items:
                phase3_items.append("No node groups with live metrics found — verify node-exporter/Container Insights is active.")

            plans.append({
                "cluster_name": cname,
                "monthly_cost": round(total_cluster_monthly, 2),
                "node_groups": [
                    {
                        "name": ng.get("nodegroupName", ""),
                        "instance_type": ng.get("instanceTypes", ["?"])[0],
                        "desired": ng.get("scalingConfig", {}).get("desiredSize", 0),
                        "monthly_cost": round(
                            INSTANCE_PRICING.get(ng.get("instanceTypes", [""])[0], 0) * 730 *
                            ng.get("scalingConfig", {}).get("desiredSize", 0), 2
                        ),
                    }
                    for ng in ngs
                ],
                "pod_rightsizing_count": len(rs_findings),
                "scale_to_zero_count": len(sz_findings),
                "phase1": phase1_items if phase1_items else ["No overprovisioned pods detected in this cluster — good!"],
                "phase2": phase2_items if phase2_items else ["No scale-to-zero candidates detected — all pods have active night traffic."],
                "phase3": phase3_items,
            })

        return plans

    def _calculate_total_costs(self):
        # Approximate AWS costs based on fetched resources
        for _ in self.aws.get("eks_clusters", []):
            self.total_cluster_cost += 73.0  # EKS control plane cost
            self.total_aws_cost += 73.0
            
        for inst in self.aws.get("ec2_instances", []):
            state = inst.get("State", "unknown")
            if state == "running":
                cost = INSTANCE_PRICING.get(inst.get("InstanceType"), 0) * 730
                self.total_aws_cost += cost
                tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                if "eks:nodegroup-name" in tags or any(k.startswith("kubernetes.io/cluster/") for k in tags):
                    self.total_cluster_cost += cost

        for vol in self.aws.get("unattached_ebs", []):
            price = EBS_GP2_PRICE_PER_GB if vol.get("VolumeType") == "gp2" else EBS_GP3_PRICE_PER_GB
            self.total_aws_cost += vol.get("SizeGb", 0) * price

        for snap in self.aws.get("old_snapshots", []):
            self.total_aws_cost += snap.get("SizeGb", 0) * SNAPSHOT_PRICE_PER_GB
            
        self.total_aws_cost += len(self.aws.get("load_balancers", [])) * ALB_PRICE_PER_HOUR * 730
        
        for b in self.aws.get("s3_buckets", []):
            self.total_aws_cost += b.get("ApproxSizeGb", 0) * 0.023

    # ─────────────────────────────────────────────────────────────────────────
    # Standalone EC2 instances
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_standalone_ec2(self):
        for inst in self.aws.get("ec2_instances", []):
            tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}

            # Skip EKS Node Group instances (already analyzed in _analyze_eks_nodes)
            if "eks:nodegroup-name" in tags or any(k.startswith("kubernetes.io/cluster/") for k in tags):
                continue

            state = inst.get("State", "unknown")
            inst_id = inst["InstanceId"]
            inst_type = inst["InstanceType"]
            name = inst.get("Name", "N/A")
            current_price = INSTANCE_PRICING.get(inst_type, 0)

            # Stopped instance cost-saving: stopping/terminating
            if state == "stopped":
                self.findings.append({
                    "category": "Investigate",
                    "resource_id": inst_id,
                    "name": name,
                    "current_state": "stopped",
                    "suggested_action": "Terminate if decommissioned to release attached volumes/EBS costs.",
                    "risk": "Low",
                    "reason": "Instance is stopped. Verify if it is still needed.",
                    "monthly_savings": 0.0,
                    "boto3_command": f"aws ec2 terminate-instances --instance-ids {inst_id} --region {self.aws.get('region', 'ap-south-1')}",
                    "terraform_snippet": None,
                })
                continue

            avg_cpu = inst.get("CloudWatchCpuAvg")
            max_cpu = inst.get("CloudWatchCpuMax")

            if avg_cpu is None:
                continue

            # Convert percentage to ratio
            avg_cpu_ratio = avg_cpu / 100.0

            # Check if idle (CPU average < threshold)
            if avg_cpu_ratio < self.idle_threshold:
                monthly_cost = current_price * 730
                self.total_savings += monthly_cost
                self.findings.append({
                    "category": "Idle EC2 Instance",
                    "resource_id": inst_id,
                    "name": f"{name} ({inst_type})",
                    "current_state": f"Running — avg CPU: {avg_cpu:.1f}%, peak CPU: {max_cpu:.1f}%",
                    "suggested_action": "STOP or TERMINATE instance",
                    "risk": "Medium",
                    "reason": f"Instance average CPU is {avg_cpu:.1f}% (threshold: {self.cfg['analysis']['idle_cpu_threshold_pct']}%).",
                    "monthly_savings": monthly_cost,
                    "boto3_command": f"aws ec2 stop-instances --instance-ids {inst_id} --region {self.aws.get('region', 'ap-south-1')}",
                    "terraform_snippet": None,
                })
            # Check if rightsizing is possible
            elif avg_cpu_ratio < self.rs_threshold and inst_type in DOWNSIZE_MAP:
                smaller = DOWNSIZE_MAP[inst_type]
                savings = (current_price - INSTANCE_PRICING.get(smaller, 0)) * 730
                self.total_savings += savings
                self.findings.append({
                    "category": "Right-sizing",
                    "resource_id": inst_id,
                    "name": f"{name} ({inst_type})",
                    "current_state": f"Running — avg CPU: {avg_cpu:.1f}%, peak CPU: {max_cpu:.1f}%",
                    "suggested_action": f"Downsize to {smaller}",
                    "risk": "Medium",
                    "reason": f"Instance average CPU is {avg_cpu:.1f}% (threshold: {self.cfg['analysis']['rightsizing_cpu_threshold_pct']}%).",
                    "monthly_savings": savings,
                    "boto3_command": f"# Stop, modify instance type, and start:\n# aws ec2 stop-instances --instance-ids {inst_id}\n# aws ec2 modify-instance-attribute --instance-id {inst_id} --instance-type {smaller}\n# aws ec2 start-instances --instance-ids {inst_id}",
                    "terraform_snippet": None,
                })

    # ─────────────────────────────────────────────────────────────────────────
    # 1. EBS Hygiene
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_ebs_hygiene(self):
        for vol in self.aws.get("unattached_ebs", []):
            vol_type = vol.get("VolumeType", "gp2")
            size_gb = vol.get("SizeGb", 0)
            price_per_gb = EBS_GP2_PRICE_PER_GB if vol_type == "gp2" else EBS_GP3_PRICE_PER_GB
            monthly_cost = size_gb * price_per_gb
            self.total_savings += monthly_cost

            action = "DELETE unattached volume"
            if vol_type == "gp2":
                action = "Convert to gp3 OR DELETE (unattached)"

            # Resolve EKS cluster name from tags or namespace
            tags = {t["Key"]: t["Value"] for t in vol.get("Tags", [])}
            cluster_name = None
            for k in tags:
                if k.startswith("kubernetes.io/cluster/"):
                    cluster_name = k.split("/")[-1]
                    break
            
            if not cluster_name:
                ns = tags.get("kubernetes.io/created-for/pvc/namespace")
                if ns:
                    active_clusters = [c["cluster"]["name"] for c in self.aws.get("eks_clusters", [])]
                    matched = None
                    for c_name in active_clusters:
                        if ns in c_name or (ns == "qa" and ("qa" in c_name or "sit" in c_name)):
                            matched = c_name
                            break
                    if matched:
                        cluster_name = matched
                    else:
                        if ns in ("prod", "backup", "monitoring"):
                            cluster_name = "dgcare-prod"
                        elif ns == "qa":
                            cluster_name = "dgcare-qa"
                        elif ns in ("dev", "kserve", "litellm", "linkerd"):
                            cluster_name = "dgcare-dev"
            
            if not cluster_name:
                cluster_name = "N/A"

            volume_name = vol.get("Name", "N/A")
            if cluster_name != "N/A":
                if volume_name == "N/A" or not volume_name:
                    volume_name = f"Cluster: {cluster_name}"
                else:
                    volume_name = f"{volume_name} (Cluster: {cluster_name})"

            self.findings.append({
                "category": "EBS Hygiene",
                "resource_id": vol["VolumeId"],
                "name": volume_name,
                "current_state": f"{size_gb}GB {vol_type} — unattached (available)",
                "suggested_action": action,
                "risk": "Low",
                "reason": "Volume has no attachments. Paying for unused storage.",
                "monthly_savings": monthly_cost,
                "boto3_command": f"aws ec2 delete-volume --volume-id {vol['VolumeId']} --region {self.aws.get('region', 'ap-south-1')}",
                "terraform_snippet": None,
            })

    # ─────────────────────────────────────────────────────────────────────────
    # 2. Old Snapshots
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_snapshots(self):
        for snap in self.aws.get("old_snapshots", []):
            size_gb = snap.get("SizeGb", 0)
            age = snap.get("AgeDays", 0)
            monthly_cost = size_gb * SNAPSHOT_PRICE_PER_GB
            self.total_savings += monthly_cost
            self.findings.append({
                "category": "Snapshot Hygiene",
                "resource_id": snap["SnapshotId"],
                "name": snap.get("Description", "N/A")[:50],
                "current_state": f"{size_gb}GB snapshot, {age} days old (volume: {snap.get('VolumeId','N/A')})",
                "suggested_action": "DELETE old snapshot",
                "risk": "Low",
                "reason": f"Snapshot is {age} days old (threshold: {self.cfg['analysis']['old_snapshot_days']} days).",
                "monthly_savings": monthly_cost,
                "boto3_command": f"aws ec2 delete-snapshot --snapshot-id {snap['SnapshotId']} --region {self.aws.get('region','ap-south-1')}",
                "terraform_snippet": None,
            })

    # ─────────────────────────────────────────────────────────────────────────
    # 3. Load Balancers
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_load_balancers(self):
        for lb in self.aws.get("load_balancers", []):
            healthy = lb.get("HealthyTargets", 0)
            state = lb.get("State", "")
            monthly_cost = ALB_PRICE_PER_HOUR * 730

            if healthy == 0 and state == "active":
                self.total_savings += monthly_cost
                self.findings.append({
                    "category": "Idle Load Balancer",
                    "resource_id": lb["Name"],
                    "name": lb["DNSName"],
                    "current_state": f"{lb['Type'].upper()} — active but 0 healthy targets",
                    "suggested_action": "INVESTIGATE then DELETE if unused",
                    "risk": "Medium",
                    "reason": "Load Balancer is active with no healthy backend targets. Likely idle.",
                    "monthly_savings": monthly_cost,
                    "boto3_command": (
                        f"# First verify, then delete:\n"
                        f"aws elbv2 describe-target-health --target-group-arn <TG_ARN>\n"
                        f"# aws elbv2 delete-load-balancer --load-balancer-arn {lb['LoadBalancerArn']}"
                    ),
                    "terraform_snippet": None,
                })

    # ─────────────────────────────────────────────────────────────────────────
    # 4. EKS Node Group Right-sizing
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_eks_nodes(self):
        node_cpu = _parse_metric_map(
            self.metrics.get("node_cpu_utilization", []),
            key_labels=("node",)
        )
        node_mem = _parse_metric_map(
            self.metrics.get("node_memory_utilization", []),
            key_labels=("node",)
        )

        for cluster in self.aws.get("eks_clusters", []):
            cluster_name = cluster["cluster"]["name"]
            for ng in cluster.get("nodegroups", []):
                ng_name = ng["nodegroupName"]
                instance_type = ng.get("instanceTypes", ["unknown"])[0]
                desired = ng.get("scalingConfig", {}).get("desiredSize", 0)
                current_price = INSTANCE_PRICING.get(instance_type, 0)

                # If we have node metrics, check utilization
                avg_cpu = 0.0
                avg_mem = 0.0
                matched_nodes = 0
                for node_key, cpu_val in node_cpu.items():
                    node_name = node_key[0] if isinstance(node_key, tuple) else node_key
                    if cluster_name in node_name or ng_name in node_name:
                        avg_cpu += cpu_val
                        avg_mem += node_mem.get(node_key, 0)
                        matched_nodes += 1

                if matched_nodes > 0:
                    avg_cpu /= matched_nodes
                    avg_mem /= matched_nodes

                # Fallback to CloudWatch metrics if Prometheus metrics are missing
                using_cloudwatch = False
                if matched_nodes == 0:
                    cw_cpus_avg = []
                    cw_cpus_max = []
                    for inst in self.aws.get("ec2_instances", []):
                        tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                        if tags.get("eks:nodegroup-name") == ng_name and f"kubernetes.io/cluster/{cluster_name}" in tags:
                            if inst.get("CloudWatchCpuAvg") is not None:
                                cw_cpus_avg.append(inst["CloudWatchCpuAvg"])
                                cw_cpus_max.append(inst["CloudWatchCpuMax"])

                    if cw_cpus_avg:
                        avg_cpu = (sum(cw_cpus_avg) / len(cw_cpus_avg)) / 100.0  # percentage to 0-1 ratio
                        avg_mem = 0.05  # assume 5% memory usage as a placeholder
                        matched_nodes = len(cw_cpus_avg)
                        using_cloudwatch = True

                # Check if node is idle
                if matched_nodes > 0 and avg_cpu < self.idle_threshold and avg_mem < 0.10:
                    savings = current_price * 730 * desired
                    self.total_savings += savings * 0.5  # conservative estimate
                    source_label = " (via CloudWatch fallback)" if using_cloudwatch else ""
                    self.findings.append({
                        "category": "Idle Node Group",
                        "resource_id": f"{cluster_name}/{ng_name}",
                        "name": f"{ng_name} ({instance_type} x{desired})",
                        "current_state": f"CPU: {avg_cpu*100:.1f}%, Mem: {avg_mem*100:.1f}% — {desired} nodes{source_label}",
                        "suggested_action": f"Scale down desired count or downsize to {DOWNSIZE_MAP.get(instance_type, 'smaller type')}",
                        "risk": "Medium",
                        "reason": f"Average CPU < {self.idle_threshold*100}% over {self.cfg['analysis']['lookback_days']} days.",
                        "monthly_savings": savings * 0.5,
                        "boto3_command": None,
                        "terraform_snippet": self._ng_terraform_snippet(ng_name, instance_type, desired),
                    })
                # Check for right-sizing opportunity
                elif matched_nodes > 0 and avg_cpu < self.rs_threshold and instance_type in DOWNSIZE_MAP:
                    smaller = DOWNSIZE_MAP[instance_type]
                    savings = (current_price - INSTANCE_PRICING.get(smaller, 0)) * 730 * desired
                    self.total_savings += savings
                    source_label = " (via CloudWatch fallback)" if using_cloudwatch else ""
                    self.findings.append({
                        "category": "Right-sizing",
                        "resource_id": f"{cluster_name}/{ng_name}",
                        "name": f"{ng_name}",
                        "current_state": f"{instance_type} x{desired} — peak CPU: {avg_cpu*100:.1f}%{source_label}",
                        "suggested_action": f"Downsize to {smaller}",
                        "risk": "Medium",
                        "reason": f"Peak CPU < {self.rs_threshold*100}% of node capacity over {self.cfg['analysis']['lookback_days']} days.",
                        "monthly_savings": savings,
                        "boto3_command": None,
                        "terraform_snippet": self._ng_terraform_snippet(ng_name, smaller, desired),
                    })
                elif matched_nodes == 0:
                    self.findings.append({
                        "category": "Investigate",
                        "resource_id": f"{cluster_name}/{ng_name}",
                        "name": f"{ng_name} ({instance_type} x{desired})",
                        "current_state": "No Prometheus node metrics or CloudWatch data found",
                        "suggested_action": "INVESTIGATE — verify node_exporter is running",
                        "risk": "Low",
                        "reason": "No metrics available; cannot assess utilization.",
                        "monthly_savings": 0,
                        "boto3_command": None,
                        "terraform_snippet": None,
                    })

    # ─────────────────────────────────────────────────────────────────────────
    # 5. Pod Right-sizing
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_pod_rightsizing(self):
        cpu_actual = _parse_metric_map(self.metrics.get("cpu_actual_avg", []))
        cpu_requests = _parse_metric_map(self.metrics.get("cpu_requests", []))
        cpu_peak = _parse_metric_map(self.metrics.get("cpu_peak", []))
        mem_actual = _parse_metric_map(self.metrics.get("memory_actual_avg", []))
        mem_requests = _parse_metric_map(self.metrics.get("memory_requests", []))
        cpu_throttled = _parse_metric_map(self.metrics.get("cpu_throttling", []))
        oom_killed = _parse_metric_map(self.metrics.get("oom_kills", []))

        # Fallback to Container Insights metrics if Prometheus is empty
        using_ci = False
        if not cpu_requests and self.aws.get("container_insights"):
            ci = self.aws["container_insights"]
            using_ci = True

            for item in ci.get("pod_cpu_request", []):
                key = (item["pod"], item["namespace"])
                cpu_requests[key] = item["value"] / 1000.0

            for item in ci.get("pod_cpu_avg", []):
                key = (item["pod"], item["namespace"])
                cpu_actual[key] = item["value"] / 1000.0

            for item in ci.get("pod_cpu_peak", []):
                key = (item["pod"], item["namespace"])
                cpu_peak[key] = item["value"] / 1000.0

            for item in ci.get("pod_mem_request", []):
                key = (item["pod"], item["namespace"])
                mem_requests[key] = item["value"]

            for item in ci.get("pod_mem_avg", []):
                key = (item["pod"], item["namespace"])
                mem_actual[key] = item["value"]

        rs_threshold = self.rs_threshold
        processed = set()

        for key, cpu_req in cpu_requests.items():
            pod, namespace = key[0], key[1]
            # Deduplicate by stripping pod hash suffix
            base = "-".join(pod.split("-")[:-2]) if len(pod.split("-")) > 2 else pod
            dedup_key = (base, namespace)
            if dedup_key in processed:
                continue
            processed.add(dedup_key)

            peak_cpu = cpu_peak.get(key, 0)
            avg_cpu = cpu_actual.get(key, 0)
            mem_req = mem_requests.get(key, 0)
            avg_mem = mem_actual.get(key, 0)
            throttles = cpu_throttled.get(key, 0.0)
            ooms = oom_killed.get(key, 0.0)

            if cpu_req == 0:
                continue

            # Safety Guard: If pod is actively crashing/terminating with OOMKills, recommend resource increase
            if ooms > 0:
                suggested_mem_mb = int((max(avg_mem, mem_req) * 1.3) / (1024 * 1024))
                # Ensure it's at least 256Mi
                suggested_mem_mb = max(suggested_mem_mb, 256)
                self.findings.append({
                    "category": "Pod Right-sizing",
                    "resource_id": f"{namespace}/{base}",
                    "name": base,
                    "current_state": f"OOMKills detected: {int(ooms)} times!",
                    "suggested_action": f"Increase Memory request to {suggested_mem_mb}Mi (current: {int(mem_req / (1024*1024))}Mi)",
                    "risk": "High",
                    "reason": f"Active OOMKills detected for {base} container. The pod was killed due to memory starvation. Increasing memory allocation is critical to stabilize the service.",
                    "monthly_savings": 0.0,
                    "boto3_command": None,
                    "terraform_snippet": None,
                    "helm_patch": self._pod_resource_patch(base, namespace, cpu_req, suggested_mem_mb),
                })
                continue

            # Safety Guard: High CPU Throttling detected -> flag cost-performance risk
            if throttles > 0.5:
                # Recommend increasing CPU limits or requests
                suggested_cpu = round(cpu_req * 1.25, 3)
                self.findings.append({
                    "category": "Pod Right-sizing",
                    "resource_id": f"{namespace}/{base}",
                    "name": base,
                    "current_state": f"CPU Throttling detected: {throttles:.2f}s/sec CFS throttled",
                    "suggested_action": f"Increase CPU limit to {suggested_cpu*2000:.0f}m",
                    "risk": "Low",
                    "reason": f"High CFS throttling detected on {base} ({throttles:.2f}s/sec). Downsizing CPU requests is risky as it could worsen latency and trigger SLO failures.",
                    "monthly_savings": 0.0,
                    "boto3_command": None,
                    "terraform_snippet": None,
                    "helm_patch": None,
                })
                continue

            cpu_utilization = peak_cpu / cpu_req if cpu_req > 0 else 1

            if cpu_utilization < rs_threshold:
                suggested_cpu = round(peak_cpu * 1.5, 3)  # 1.5x peak as new request
                mem_utilization = avg_mem / mem_req if mem_req > 0 else 1
                suggested_mem_mb = int((avg_mem * 1.5) / (1024 * 1024))

                self.findings.append({
                    "category": "Pod Right-sizing",
                    "resource_id": f"{namespace}/{base}",
                    "name": base,
                    "current_state": (
                        f"CPU request: {cpu_req*1000:.0f}m, "
                        f"peak used: {peak_cpu*1000:.0f}m ({cpu_utilization*100:.1f}%)" + (" (via Container Insights fallback)" if using_ci else "")
                    ),
                    "suggested_action": (
                        f"Reduce CPU request to {suggested_cpu*1000:.0f}m, "
                        f"Memory to {suggested_mem_mb}Mi"
                    ),
                    "risk": "Low",
                    "reason": f"Peak CPU is only {cpu_utilization*100:.1f}% of requested. Wasting cluster capacity.",
                    "monthly_savings": 0,  # Indirect saving via better bin-packing
                    "boto3_command": None,
                    "terraform_snippet": None,
                    "helm_patch": self._pod_resource_patch(base, namespace, suggested_cpu, suggested_mem_mb),
                })

    # ─────────────────────────────────────────────────────────────────────────
    # 6. Scale-to-Zero Candidates
    # ─────────────────────────────────────────────────────────────────────────
    def _analyze_scale_to_zero(self):
        night_net = self.metrics.get("night_network", [])
        # Find pods with near-zero night traffic
        night_map = {}
        for series in night_net:
            pod = series.get("metric", {}).get("pod", "")
            ns = series.get("metric", {}).get("namespace", "")
            values = series.get("values", [])
            # Separate night hours (UTC 18:30-02:30 = IST 00:00-08:00)
            night_values = []
            for ts, val in values:
                hour = datetime.datetime.utcfromtimestamp(ts).hour
                if hour >= 18 or hour < 3:
                    try:
                        night_values.append(float(val))
                    except Exception:
                        pass
            if night_values:
                avg_night = sum(night_values) / len(night_values)
                base = "-".join(pod.split("-")[:-2]) if len(pod.split("-")) > 2 else pod
                night_map[(base, ns)] = avg_night

        for (pod, ns), avg_night in night_map.items():
            if avg_night < 100:  # < 100 bytes/sec at night = essentially idle
                self.findings.append({
                    "category": "Scale-to-Zero Candidate",
                    "resource_id": f"{ns}/{pod}",
                    "name": pod,
                    "current_state": f"Night traffic avg: {avg_night:.1f} B/s (12AM–8AM IST)",
                    "suggested_action": "Add KEDA CronScaler to scale to 0 replicas at night",
                    "risk": "Medium",
                    "reason": "Near-zero network traffic during off-hours. Safe for KEDA scale-to-zero.",
                    "monthly_savings": 0,
                    "boto3_command": None,
                    "terraform_snippet": None,
                    "keda_snippet": self._keda_cron_snippet(pod, ns),
                })

    # ─────────────────────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────────────────────
    def _ng_terraform_snippet(self, ng_name: str, instance_type: str, desired: int) -> str:
        return f"""# In your eks terraform.tfvars or node group module:
node_groups = {{
  {ng_name} = {{
    instance_type  = "{instance_type}"   # <-- Updated
    desired_size   = {desired}
    min_size       = 1
    max_size       = {desired + 2}
    disk_size      = 50
    disk_type      = "gp3"               # Ensure gp3
  }}
}}"""

    def _pod_resource_patch(self, name: str, namespace: str, cpu: float, mem_mb: int) -> str:
        return f"""# Add to your HelmRelease values override:
# In {namespace}-helmrelease.yaml:
resources:
  requests:
    cpu: "{int(cpu * 1000)}m"
    memory: "{mem_mb}Mi"
  limits:
    cpu: "{int(cpu * 2000)}m"
    memory: "{int(mem_mb * 1.5)}Mi"
"""

    def _keda_cron_snippet(self, name: str, namespace: str) -> str:
        return f"""apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: {name}-cron-scaler
  namespace: {namespace}
spec:
  scaleTargetRef:
    name: {name}
  minReplicaCount: 0
  maxReplicaCount: 3
  triggers:
    - type: cron
      metadata:
        timezone: "Asia/Kolkata"
        start: "0 8 * * *"   # Scale UP at 8AM IST
        end:   "0 0 * * *"   # Scale to ZERO at 12AM IST
        desiredReplicas: "2"
"""

    def _sort_findings(self):
        priority = {
            "EBS Hygiene": 1, "Snapshot Hygiene": 2, "Idle Load Balancer": 3,
            "Idle Node Group": 4, "Idle EC2 Instance": 5, "Right-sizing": 6, "Pod Right-sizing": 7,
            "Scale-to-Zero Candidate": 8, "S3 Lifecycle": 9, "S3 Intelligent-Tiering": 10,
            "EKS Control Plane": 11, "CloudFront Clean up": 12, "CloudFront Optimization": 13,
            "IAM Hygiene": 14, "Investigate": 15,
        }
        self.findings.sort(key=lambda x: (
            priority.get(x["category"], 20),
            -x.get("monthly_savings", 0.0)
        ))

    def _analyze_s3(self):
        for b in self.aws.get("s3_buckets", []):
            name = b["Name"]
            size_gb = b.get("ApproxSizeGb", 0)
            
            # S3 standard pricing: $0.023 per GB per month
            current_cost = size_gb * 0.023
            
            # Transition to Intelligent-Tiering / Lifecycle rule recommendations
            if "backup" in name.lower() or "tfstate" in name.lower() or "states" in name.lower():
                savings = current_cost * 0.60
                self.total_savings += savings
                self.findings.append({
                    "category": "S3 Lifecycle",
                    "resource_id": name,
                    "name": name,
                    "current_state": f"S3 Bucket — approx size: {size_gb:.2f} GB, est cost: ${current_cost:.2f}/mo",
                    "suggested_action": "Apply Lifecycle policy to transition objects older than 30 days to Glacier Deep Archive",
                    "risk": "Low",
                    "reason": f"S3 bucket '{name}' contains backups or terraform states. Glacier transition saves ~60% on storage costs.",
                    "monthly_savings": savings,
                    "boto3_command": f"# Configure lifecycle policy:\n# aws s3api put-bucket-lifecycle-configuration --bucket {name} --lifecycle-configuration file://lifecycle.json",
                    "terraform_snippet": f"resource \"aws_s3_bucket_lifecycle_configuration\" \"{name.replace('-', '_')}\" {{\n  bucket = \"{name}\"\n  rule {{\n    id     = \"archive\"\n    status = \"Enabled\"\n    transition {{\n      days          = 30\n      storage_class = \"GLACIER\"\n    }}\n  }}\n}}",
                })
            else:
                savings = current_cost * 0.20
                if savings > 0.05:
                    self.total_savings += savings
                    self.findings.append({
                        "category": "S3 Intelligent-Tiering",
                        "resource_id": name,
                        "name": name,
                        "current_state": f"S3 Bucket — approx size: {size_gb:.2f} GB",
                        "suggested_action": "Enable S3 Intelligent-Tiering",
                        "risk": "Low",
                        "reason": f"Enabling Intelligent-Tiering automatically transitions infrequently accessed objects to cheaper tiers without retrieval fees.",
                        "monthly_savings": savings,
                        "boto3_command": f"aws s3api put-bucket-intelligent-tiering-configuration --bucket {name} --intelligent-tiering-configuration-id DefaultTiering --intelligent-tiering-configuration '{{\"Id\": \"DefaultTiering\", \"Status\": \"Enabled\", \"TieringRecipients\": []}}'",
                        "terraform_snippet": None,
                    })

    def _analyze_cloudfront(self):
        for d in self.aws.get("cloudfront_distributions", []):
            dist_id = d["Id"]
            domain = d["DomainName"]
            enabled = d["Enabled"]
            comment = d.get("Comment", "N/A")
            
            if not enabled:
                self.findings.append({
                    "category": "CloudFront Clean up",
                    "resource_id": dist_id,
                    "name": f"CloudFront: {comment or domain}",
                    "current_state": "Disabled distribution",
                    "suggested_action": "DELETE CloudFront distribution",
                    "risk": "Low",
                    "reason": "Distribution has been disabled. Deleting it cleans up DNS and IAM roles.",
                    "monthly_savings": 0.0,
                    "boto3_command": f"aws cloudfront delete-distribution --id {dist_id} --if-match <ETag>",
                    "terraform_snippet": None,
                })
            else:
                self.findings.append({
                    "category": "CloudFront Optimization",
                    "resource_id": dist_id,
                    "name": f"CloudFront: {comment or domain}",
                    "current_state": f"Enabled — aliases: {', '.join(d['Aliases']) or 'none'}",
                    "suggested_action": "Enable gzip/brotli compression on all cache behaviors",
                    "risk": "Low",
                    "reason": "Automatically compressing text/HTML assets reduces CloudFront egress data volume, lowering AWS data transfer costs.",
                    "monthly_savings": 0.0,
                    "boto3_command": f"# Update distribution cache behaviors to enable compression (Compress=True)",
                    "terraform_snippet": None,
                })

    def _analyze_iam(self):
        import datetime
        from dateutil.parser import parse
        
        now = datetime.datetime.now(datetime.timezone.utc)
        for u in self.aws.get("iam_users", []):
            username = u["UserName"]
            for key in u.get("AccessKeys", []):
                key_id = key["AccessKeyId"]
                status = key["Status"]
                create_date = parse(key["CreateDate"])
                age_days = (now - create_date).days
                
                if age_days > 90 and status == "Active":
                    self.findings.append({
                        "category": "IAM Hygiene",
                        "resource_id": f"User: {username} (Key: {key_id})",
                        "name": f"IAM key: {username}",
                        "current_state": f"Active key, {age_days} days old",
                        "suggested_action": "Rotate or disable access key",
                        "risk": "Medium",
                        "reason": f"IAM Access Key '{key_id}' for user '{username}' is {age_days} days old. Rotating keys older than 90 days reduces security exposure.",
                        "monthly_savings": 0.0,
                        "boto3_command": f"aws iam update-access-key --access-key-id {key_id} --status Inactive --user-name {username}",
                        "terraform_snippet": None,
                    })

    def _analyze_eks_control_plane(self):
        for cluster_info in self.aws.get("eks_clusters", []):
            c = cluster_info["cluster"]
            name = c["name"]
            
            # EKS Control Plane costs $0.10/hour flat = $73.00/month
            monthly_cost = 73.00
            
            ngs = cluster_info.get("nodegroups", [])
            is_idle = len(ngs) == 0 or all(ng.get("scalingConfig", {}).get("desiredSize", 0) == 0 for ng in ngs)
            
            if is_idle:
                self.total_savings += monthly_cost
                self.findings.append({
                    "category": "EKS Control Plane",
                    "resource_id": name,
                    "name": f"EKS Cluster: {name}",
                    "current_state": f"Control Plane running — {len(ngs)} nodegroups active",
                    "suggested_action": "DELETE EKS Cluster if decommissioned",
                    "risk": "High",
                    "reason": f"EKS Cluster '{name}' has no active node workloads but still incurs a flat control plane charge of $73.00/month.",
                    "monthly_savings": monthly_cost,
                    "boto3_command": f"aws eks delete-cluster --name {name}",
                    "terraform_snippet": None,
                })

    def _analyze_loki_logs(self):
        # 1. Chatty Containers Log Volume
        log_volume = self.metrics.get("loki_log_volume", [])
        for entry in log_volume:
            metric = entry.get("metric", {})
            values = entry.get("values", []) or entry.get("value", [])
            if not values:
                continue
            
            try:
                if isinstance(values[0], list):
                    val = float(values[-1][1])
                else:
                    val = float(values[1])
            except (ValueError, TypeError, IndexError):
                continue

            namespace = metric.get("namespace", "default")
            container = metric.get("container", "unknown")
            cluster = metric.get("cluster", "unknown")

            # Threshold: > 500,000 lines/7 days
            if val > 500000:
                savings = (val / 100000.0) * 0.10
                self.total_savings += savings
                self.findings.append({
                    "category": "Loki Log Optimization",
                    "resource_id": f"Pod/Container: {namespace}/{container}",
                    "name": f"Loki Log Volume: {container}",
                    "current_state": f"Ingested {val:,.0f} log lines over the last 7 days",
                    "suggested_action": "Reduce logging verbosity (change from DEBUG to INFO/WARN) or optimize JSON logs.",
                    "risk": "Low",
                    "reason": f"Container '{container}' in namespace '{namespace}' (cluster: {cluster}) has very high log output. Ingestion and storage of chatty logs increases infrastructure costs.",
                    "monthly_savings": round(savings, 2),
                    "boto3_command": f"# Review deployment logging configs for namespace {namespace}:\n# kubectl edit deployment -n {namespace} {container}",
                    "terraform_snippet": None,
                })

        # 2. Unstable Workloads / High Error Rates
        error_volume = self.metrics.get("loki_error_volume", [])
        for entry in error_volume:
            metric = entry.get("metric", {})
            values = entry.get("values", []) or entry.get("value", [])
            if not values:
                continue
            
            try:
                if isinstance(values[0], list):
                    val = float(values[-1][1])
                else:
                    val = float(values[1])
            except (ValueError, TypeError, IndexError):
                continue

            namespace = metric.get("namespace", "default")
            container = metric.get("container", "unknown")
            cluster = metric.get("cluster", "unknown")

            # Threshold: > 1,000 errors/7 days
            if val > 1000:
                self.findings.append({
                    "category": "Loki Error Investigation",
                    "resource_id": f"Pod/Container: {namespace}/{container}",
                    "name": f"Loki Error Vol: {container}",
                    "current_state": f"Logged {val:,.0f} errors/exceptions in the last 7 days",
                    "suggested_action": "Investigate pod logs for persistent crashes or failing downstream calls.",
                    "risk": "High",
                    "reason": f"Container '{container}' (namespace: '{namespace}', cluster: {cluster}) has logged {val:,.0f} errors. Failing pods consume CPU/memory resources without serving traffic.",
                    "monthly_savings": 0.0,
                    "boto3_command": f"kubectl logs -n {namespace} -l app={container} --tail=100 | grep -i error",
                    "terraform_snippet": None,
                })

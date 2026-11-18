"""
LLM Analyzer — sends collected AWS + Prometheus data to LiteLLM
and gets back intelligent, contextual cost-optimization suggestions.
"""

import json
import requests
from rich.console import Console

console = Console()

SYSTEM_PROMPT = """You are EKS-FinOps-Architect, an expert AWS cost optimization AI.
You are given real infrastructure data from an AWS EKS environment with Prometheus metrics.

Your job is to analyze the data and produce a JSON report with intelligent, actionable cost recommendations.

RULES:
1. Every recommendation MUST reference a specific resource ID from the data.
2. For right-sizing, suggest exact CPU/Memory values (e.g., "reduce from 500m to 200m").
3. For idle resources, provide the exact AWS CLI delete command.
4. For scale-to-zero, provide a complete KEDA ScaledObject YAML manifest with IST timezone.
5. For node groups, suggest a specific smaller instance type AND provide a Terraform HCL snippet.
6. Do NOT suggest Spot instances (use On-Demand only).
7. Prefer gp3 over gp2 for all EBS volumes.
8. If a resource is a StatefulSet or has PVCs, add a "SAFETY: data loss risk" warning.
9. If data is missing for a resource, mark it as "Investigate" not "Delete".
10. Estimate monthly USD savings for each recommendation.
11. CRITICAL: The entire output must be valid JSON. You MUST properly escape all nested double quotes inside string values (e.g. use \\" for nested quotes) and never use unescaped double quotes inside strings.

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown:
{
  "executive_summary": "2-3 sentence summary of the overall state and top opportunities",
  "total_estimated_monthly_savings_usd": 0.00,
  "cluster_optimization_plans": [
    {
      "cluster_name": "name of cluster",
      "steps": [
        "Step 1: Reduce CPU and memory requests for overprovisioned pods",
        "Step 2: Reschedule pods to pack them tightly onto fewer nodes",
        "Step 3: Change node types to less costly ones or scale down/delete nodes"
      ]
    }
  ],
  "recommendations": [
    {
      "category": "EBS Hygiene|Pod Right-sizing|Node Right-sizing|Scale-to-Zero|Idle Load Balancer|Snapshot Hygiene|Investigate|Loki Log Optimization|Loki Error Investigation",
      "resource_id": "exact resource ID",
      "name": "human readable name",
      "current_state": "what it is now",
      "suggested_action": "what to do",
      "risk": "Low|Medium|High",
      "reason": "detailed explanation of WHY this is recommended, referencing actual metric values",
      "monthly_savings_usd": 0.00,
      "safety_warning": "null or warning text if data loss risk",
      "code_snippet": {
        "type": "cli|hcl|yaml|helm_patch",
        "label": "human readable label",
        "code": "the actual code/command to run"
      }
    }
  ],
  "architecture_insights": [
    "High-level insight about the overall cluster architecture, capacity planning, or spending pattern"
  ]
}
"""


def _summarize_aws_data(aws_data: dict) -> dict:
    """Compress AWS data to fit in LLM context window."""
    summary = {
        "region": aws_data.get("region", "ap-south-1"),
        "clusters": [],
        "ec2_instances": [],
        "unattached_ebs": [],
        "old_snapshots_count": len(aws_data.get("old_snapshots", [])),
        "load_balancers": [],
    }

    for cluster in aws_data.get("eks_clusters", []):
        c = cluster["cluster"]
        ngs = []
        for ng in cluster.get("nodegroups", []):
            ngs.append({
                "name": ng["nodegroupName"],
                "instance_types": ng.get("instanceTypes", []),
                "desired": ng.get("scalingConfig", {}).get("desiredSize"),
                "min": ng.get("scalingConfig", {}).get("minSize"),
                "max": ng.get("scalingConfig", {}).get("maxSize"),
                "status": ng.get("status"),
                "ami_type": ng.get("amiType"),
                "disk_size": ng.get("diskSize"),
            })
        summary["clusters"].append({
            "name": c["name"],
            "version": c.get("version"),
            "status": c.get("status"),
            "nodegroups": ngs,
        })

    for inst in aws_data.get("ec2_instances", []):
        summary["ec2_instances"].append({
            "id": inst["InstanceId"],
            "name": inst["Name"],
            "type": inst["InstanceType"],
            "state": inst["State"],
        })

    for vol in aws_data.get("unattached_ebs", []):
        summary["unattached_ebs"].append({
            "id": vol["VolumeId"],
            "name": vol.get("Name", "N/A"),
            "size_gb": vol["SizeGb"],
            "type": vol["VolumeType"],
            "created": vol["CreateTime"],
        })

    for snap in aws_data.get("old_snapshots", [])[:20]:
        summary.setdefault("old_snapshots", []).append({
            "id": snap["SnapshotId"],
            "size_gb": snap["SizeGb"],
            "age_days": snap["AgeDays"],
        })

    for lb in aws_data.get("load_balancers", []):
        summary["load_balancers"].append({
            "name": lb["Name"],
            "type": lb["Type"],
            "state": lb["State"],
            "healthy_targets": lb["HealthyTargets"],
            "target_groups": lb["TargetGroupCount"],
        })

    summary["s3_buckets"] = []
    for b in aws_data.get("s3_buckets", []):
        summary["s3_buckets"].append({
            "name": b["Name"],
            "approx_size_gb": b.get("ApproxSizeGb", 0),
            "object_count": b.get("ApproxObjectCount", 0)
        })

    summary["cloudfront_distributions"] = []
    for d in aws_data.get("cloudfront_distributions", []):
        summary["cloudfront_distributions"].append({
            "id": d["Id"],
            "enabled": d["Enabled"],
            "domain": d["DomainName"],
            "comment": d.get("Comment", "")
        })

    summary["iam_users"] = []
    for u in aws_data.get("iam_users", []):
        summary["iam_users"].append({
            "username": u["UserName"],
            "keys_count": len(u.get("AccessKeys", []))
        })

    if "container_insights" in aws_data:
        summary["container_insights"] = aws_data["container_insights"]

    return summary


def _summarize_metrics(metrics: dict) -> dict:
    """Compress Prometheus metrics for the LLM, keeping top values."""
    summary = {}

    for key in ["cpu_actual_avg", "cpu_requests", "cpu_peak",
                 "memory_actual_avg", "memory_requests", "memory_peak"]:
        entries = metrics.get(key, [])
        compact = []
        for item in entries[:80]:
            m = item.get("metric", {})
            val = item.get("value", [None, "0"])
            try:
                v = float(val[1])
            except (IndexError, ValueError, TypeError):
                v = 0
            compact.append({
                "pod": m.get("pod", ""),
                "ns": m.get("namespace", ""),
                "value": round(v, 6),
            })
        summary[key] = compact

    # Node utilization
    for key in ["node_cpu_utilization", "node_memory_utilization"]:
        entries = metrics.get(key, [])
        compact = []
        for item in entries[:20]:
            m = item.get("metric", {})
            val = item.get("value", [None, "0"])
            try:
                v = float(val[1])
            except (IndexError, ValueError, TypeError):
                v = 0
            label = m.get("node", m.get("instance", ""))
            compact.append({"node": label, "value": round(v, 4)})
        summary[key] = compact

    # Loki metrics
    for key in ["loki_log_volume", "loki_error_volume"]:
        entries = metrics.get(key, [])
        compact = []
        for item in entries[:30]:
            m = item.get("metric", {})
            val = item.get("values", []) or item.get("value", [])
            if not val:
                continue
            try:
                if isinstance(val[0], list):
                    v = float(val[-1][1])
                else:
                    v = float(val[1])
            except (IndexError, ValueError, TypeError):
                v = 0
            compact.append({
                "container": m.get("container", ""),
                "ns": m.get("namespace", ""),
                "cluster": m.get("cluster", ""),
                "value": round(v, 2),
            })
        summary[key] = compact

    return summary


class LLMAnalyzer:
    def __init__(self, config: dict):
        self.base_url = config["litellm"]["url"].rstrip("/")
        self.api_key = config["litellm"]["api_key"]
        self.model = config["litellm"].get("model", "llm-heavy")
        self.timeout = config["litellm"].get("timeout", 120)

    def analyze(self, aws_data: dict, grafana_data: dict) -> dict:
        console.print("[bold cyan]🤖 Sending data to LLM for AI analysis...[/bold cyan]")

        aws_summary = _summarize_aws_data(aws_data)
        metrics_summary = _summarize_metrics(grafana_data.get("metrics", {}))

        user_prompt = f"""Analyze the following real infrastructure data and generate cost optimization recommendations.

## AWS Infrastructure Inventory
```json
{json.dumps(aws_summary, indent=2, default=str)}
```

## Prometheus Metrics (7-day averages)
```json
{json.dumps(metrics_summary, indent=2, default=str)}
```

Generate your JSON response with specific, actionable recommendations.
Include exact CLI commands, Terraform HCL, or KEDA YAML where applicable.
Reference actual resource IDs, pod names, and metric values from the data above."""

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": 8000,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }

        try:
            console.print(f"  [dim]Model: {self.model} | Endpoint: {self.base_url}[/dim]")
            resp = requests.post(
                f"{self.base_url}/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=self.timeout,
            )
            resp.raise_for_status()

            content = resp.json()["choices"][0]["message"]["content"]

            # Strip markdown code fences if present
            content = content.strip()
            if content.startswith("```"):
                first_newline = content.index("\n")
                content = content[first_newline + 1:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()

            try:
                result = json.loads(content)
            except json.JSONDecodeError:
                import re
                # Self-healing: remove trailing commas before closing braces/brackets
                content_fixed = re.sub(r',\s*([\]}])', r'\1', content)
                result = json.loads(content_fixed)

            rec_count = len(result.get("recommendations", []))
            savings = result.get("total_estimated_monthly_savings_usd", 0)
            console.print(
                f"[green]✅ LLM analysis complete:[/green] "
                f"{rec_count} recommendations, "
                f"estimated savings: [bold green]${savings:,.2f}/month[/bold green]"
            )
            return result

        except json.JSONDecodeError as e:
            console.print(f"[yellow]⚠ LLM returned invalid JSON: {e}[/yellow]")
            console.print(f"[dim]Raw response (first 500 chars): {content[:500]}[/dim]")
            return {"error": str(e), "raw_response": content[:2000],
                    "recommendations": [], "executive_summary": "LLM response parsing failed."}
        except requests.exceptions.Timeout:
            console.print(f"[red]✗ LLM request timed out after {self.timeout}s[/red]")
            return {"error": "timeout", "recommendations": [],
                    "executive_summary": "LLM request timed out."}
        except Exception as e:
            console.print(f"[red]✗ LLM analysis failed: {e}[/red]")
            return {"error": str(e), "recommendations": [],
                    "executive_summary": f"LLM analysis failed: {e}"}

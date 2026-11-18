#!/usr/bin/env python3
"""
EKS-FinOps-Architect Agent
--------------------------
Read-only AWS + Grafana cost optimization agent.

Usage:
  python main.py                    # Uses config.yaml
  python main.py --config my.yaml   # Custom config path
  python main.py --aws-only         # Skip Grafana (AWS hygiene only)
  python main.py --no-browser       # Don't auto-open the HTML report
"""
import os, sys
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf-8-sig"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import argparse
import sys
import yaml
from pathlib import Path
from rich.console import Console
from rich.panel import Panel
from rich.text import Text

console = Console()

BANNER = """
+===================================================+
|   EKS FinOps Architect Agent v2.0 (AI-Powered)    |
|   AWS Read-Only | Grafana | LiteLLM               |
+===================================================+
"""


def load_config(path: str) -> dict:
    cfg_path = Path(path)
    if not cfg_path.exists():
        console.print(f"[red]✗ Config file not found: {path}[/red]")
        console.print("[yellow]  Copy config.yaml.example → config.yaml and fill in your credentials.[/yellow]")
        sys.exit(1)
    with open(cfg_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def main():
    console.print(Text(BANNER, style="bold cyan"))

    parser = argparse.ArgumentParser(description="EKS FinOps Architect Agent")
    parser.add_argument("--config", default="config.yaml", help="Path to config YAML")
    parser.add_argument("--aws-only", action="store_true", help="Skip Grafana collection")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open the report")
    parser.add_argument("--no-llm", action="store_true", help="Skip LLM analysis (rule-based only)")
    parser.add_argument("--cluster", help="Filter Grafana collection to a specific cluster name (e.g. medvista-global-dev)")
    args = parser.parse_args()

    config = load_config(args.config)

    if args.cluster and "grafana_clusters" in config:
        target_cluster = args.cluster.strip().lower()
        config["grafana_clusters"] = [
            c for c in config["grafana_clusters"]
            if c.get("cluster_name", "").strip().lower() == target_cluster
        ]
        console.print(f"[cyan]🎯 Target cluster set to: {args.cluster}[/cyan]")

    if args.no_browser:
        config["report"]["open_in_browser"] = False

    # ── 1. Collect AWS Data ────────────────────────────────────────────────
    console.print(Panel("[bold]Step 1/4[/bold] · Collecting AWS Inventory", style="blue"))
    from collectors.aws_collector import AWSCollector
    aws_data = AWSCollector(config).collect_all()
    aws_data["region"] = config["aws"]["region"]

    # ── Fallback: reuse last report's data for any component that failed ───
    # If a component returned empty (timeout/error), load the most recent
    # successful report JSON and carry forward that component's data.
    _fallback_components = {
        "ec2_instances":           "ec2_instances",
        "unattached_ebs":          "unattached_ebs",
        "old_snapshots":           "old_snapshots",
        "load_balancers":          "load_balancers",
        "s3_buckets":              "s3_buckets",
        "cloudfront_distributions":"cloudfront_distributions",
        "iam_users":               "iam_users",
    }
    _needs_fallback = [k for k, v in _fallback_components.items() if not aws_data.get(v)]
    if _needs_fallback:
        import glob, json as _json
        _cfg = config.get("report", {})
        _rdir = Path(_cfg.get("output_dir", "reports"))
        _prev = sorted(glob.glob(str(_rdir / "finops_report_*.json")), reverse=True)
        if _prev:
            try:
                with open(_prev[0], "r", encoding="utf-8") as _f:
                    _prev_data = _json.load(_f)
                _prev_aws = _prev_data.get("aws_data", {})
                for _k in _needs_fallback:
                    _fb = _prev_aws.get(_k)
                    if _fb:
                        console.print(f"  [yellow]⚠ {_k} timed out — reusing data from last report ({Path(_prev[0]).name})[/yellow]")
                        aws_data[_k] = _fb
            except Exception as _e:
                console.print(f"  [yellow]⚠ Could not load fallback report: {_e}[/yellow]")

    # ── 2. Collect Grafana/Prometheus Metrics ─────────────────────────────
    grafana_data = {"metrics": {}}
    if not args.aws_only:
        console.print(Panel("[bold]Step 2/4[/bold] · Collecting Grafana Metrics", style="blue"))
        try:
            from collectors.grafana_collector import GrafanaCollector
            if "grafana_clusters" in config:
                merged_metrics = {}
                for g_config in config["grafana_clusters"]:
                    cluster_name = g_config.get("cluster_name")
                    console.print(f"  [dim]Collecting Grafana metrics for cluster: {cluster_name}...[/dim]")
                    try:
                        collector = GrafanaCollector(
                            config,
                            cluster_name=cluster_name,
                            url=g_config.get("url"),
                            username=g_config.get("username"),
                            password=g_config.get("password")
                        )
                        res = collector.collect_all()
                        cluster_metrics = res.get("metrics", {})
                        for k, v in cluster_metrics.items():
                            if isinstance(v, list):
                                # Stamp every entry with the source EKS cluster name
                                stamped = []
                                for entry in v:
                                    if isinstance(entry, dict):
                                        e2 = dict(entry)
                                        m = dict(e2.get("metric", {}))
                                        if not m.get("cluster"):
                                            m["cluster"] = cluster_name
                                        e2["metric"] = m
                                        stamped.append(e2)
                                    else:
                                        stamped.append(entry)
                                merged_metrics.setdefault(k, []).extend(stamped)
                    except Exception as e:
                        console.print(f"  [red]✗ Grafana collection failed for {cluster_name}: {e}[/red]")
                grafana_data = {"metrics": merged_metrics}
            else:
                grafana_data = GrafanaCollector(config).collect_all()
        except Exception as e:
            console.print(f"[yellow]⚠ Grafana collection failed: {e}[/yellow]")
            console.print("[yellow]  Continuing with AWS-only analysis...[/yellow]")
    else:
        console.print("[dim]Skipping Grafana collection (--aws-only flag)[/dim]")

    # ── 3. LLM-Powered Analysis ──────────────────────────────────────────
    llm_result = {}
    if not args.no_llm and config.get("litellm"):
        console.print(Panel("[bold]Step 3/4[/bold] · AI Analysis via LiteLLM", style="magenta"))
        try:
            from analyzers.llm_analyzer import LLMAnalyzer
            llm_result = LLMAnalyzer(config).analyze(aws_data, grafana_data)
        except Exception as e:
            console.print(f"[yellow]⚠ LLM analysis failed: {e}[/yellow]")
            console.print("[yellow]  Falling back to rule-based analysis only...[/yellow]")
    else:
        console.print("[dim]Skipping LLM analysis (--no-llm flag or no litellm config)[/dim]")

    # ── 4. Rule-based Analysis ───────────────────────────────────────────
    console.print(Panel("[bold]Step 4/4[/bold] · Running Rule-based FinOps Analysis", style="blue"))
    from analyzers.finops_analyzer import FinOpsAnalyzer
    rule_analysis = FinOpsAnalyzer(config, aws_data, grafana_data).analyze()

    # ── Merge LLM + rule-based results ───────────────────────────────────
    analysis = rule_analysis
    analysis["llm_executive_summary"] = llm_result.get("executive_summary", "")
    analysis["llm_insights"] = llm_result.get("architecture_insights", [])
    analysis["llm_total_savings"] = llm_result.get("total_estimated_monthly_savings_usd", 0)
    analysis["cluster_optimization_plans"] = llm_result.get("cluster_optimization_plans", [])
    # cluster_plans is already set in rule_analysis from _build_cluster_plans()

    # Convert LLM recommendations into the same format as rule-based
    for rec in llm_result.get("recommendations", []):
        snippet = rec.get("code_snippet", {})
        finding = {
            "category": rec.get("category", "Investigate"),
            "resource_id": rec.get("resource_id", "N/A"),
            "name": rec.get("name", ""),
            "current_state": rec.get("current_state", ""),
            "suggested_action": rec.get("suggested_action", ""),
            "risk": rec.get("risk", "Medium"),
            "reason": rec.get("reason", ""),
            "monthly_savings": rec.get("monthly_savings_usd", 0),
            "source": "ai",  # tag to distinguish from rule-based
        }
        # Map snippet type to the right key
        if snippet:
            code = snippet.get("code", "")
            stype = snippet.get("type", "")
            label = snippet.get("label", "")
            if stype == "cli":
                finding["boto3_command"] = code
            elif stype == "hcl":
                finding["terraform_snippet"] = code
            elif stype == "yaml":
                finding["keda_snippet"] = code
            elif stype == "helm_patch":
                finding["helm_patch"] = code

        # Add safety warning to reason if present
        if rec.get("safety_warning"):
            finding["reason"] += f" ⚠️ SAFETY: {rec['safety_warning']}"

        analysis["findings"].append(finding)

    # Deduplicate: if LLM and rules found the same resource, keep the LLM one
    seen = {}
    deduped = []
    for f in analysis["findings"]:
        key = (f["category"], f["resource_id"])
        if key in seen:
            # Keep the AI version over rule-based
            if f.get("source") == "ai":
                deduped[seen[key]] = f
        else:
            seen[key] = len(deduped)
            deduped.append(f)
    analysis["findings"] = deduped

    # ── 5. Generate Report ────────────────────────────────────────────────
    from reporters.html_reporter import HTMLReporter
    # Stash raw aws_data so the reporter embeds it in JSON for future fallback
    analysis["_aws_data"] = aws_data
    analysis["_grafana_data"] = grafana_data
    report_path = HTMLReporter(config).generate(analysis)

    total_findings = len(analysis["findings"])
    ai_count = sum(1 for f in analysis["findings"] if f.get("source") == "ai")
    rule_count = total_findings - ai_count

    console.print()
    console.print(Panel(
        f"[bold green]✅ Done![/bold green]\n"
        f"Total Findings: [bold]{total_findings}[/bold] "
        f"({ai_count} AI + {rule_count} rule-based)\n"
        f"Rule-based Savings: [bold green]${analysis['total_savings']:,.2f}[/bold green]/mo\n"
        f"AI-estimated Savings: [bold green]${analysis.get('llm_total_savings', 0):,.2f}[/bold green]/mo\n"
        f"Report: [cyan]{report_path}[/cyan]",
        title="FinOps Analysis Complete",
        style="green"
    ))


if __name__ == "__main__":
    main()


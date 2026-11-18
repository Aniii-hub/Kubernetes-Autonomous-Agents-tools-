#!/usr/bin/env python3
import sys
import os
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf-8-sig"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import json
import glob
from pathlib import Path
from reporters.html_reporter import HTMLReporter
from analyzers.finops_analyzer import FinOpsAnalyzer

def render_last():
    # Load config
    import yaml
    with open("config.yaml", "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    # Find latest JSON report
    reports_dir = Path("reports")
    json_files = sorted(reports_dir.glob("finops_report_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not json_files:
        print("No reports found to render!")
        return

    latest_json = json_files[0]
    print(f"Reading data from: {latest_json}")
    with open(latest_json, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Extract stored AWS and Grafana data
    aws_data = data.get("_aws_data", {})
    grafana_data = data.get("_grafana_data", {"metrics": {}})
    metrics = grafana_data.setdefault("metrics", {})

    # Mock Loki metrics to test Loki collector/analyzer parsing
    metrics["loki_log_volume"] = [
        {
            "metric": {"container": "auth-service", "namespace": "healthcare", "cluster": "medvista-k8s-v2-prod"},
            "value": [0, "1250000"]
        },
        {
            "metric": {"container": "gateway", "namespace": "healthcare", "cluster": "medvista-k8s-v2-prod"},
            "value": [0, "850000"]
        }
    ]
    metrics["loki_error_volume"] = [
        {
            "metric": {"container": "auth-service", "namespace": "healthcare", "cluster": "medvista-k8s-v2-prod"},
            "value": [0, "4500"]
        },
        {
            "metric": {"container": "patient-records", "namespace": "healthcare", "cluster": "medvista-k8s-v2-qa-sit"},
            "value": [0, "1200"]
        }
    ]
    
    # Create analyzer with loaded AWS/Grafana data
    analyzer = FinOpsAnalyzer(config, aws_data, grafana_data)
    # Re-run rule-based analysis (so it runs the new total cost logic and per-cluster plans!)
    new_analysis = analyzer.analyze()
    
    # Preserve LLM fields if they were in the original JSON
    new_analysis["llm_executive_summary"] = data.get("llm_executive_summary", "")
    new_analysis["llm_insights"] = data.get("llm_insights", [])
    new_analysis["llm_total_savings"] = data.get("llm_total_savings", 0)
    new_analysis["cluster_optimization_plans"] = data.get("cluster_optimization_plans", [])

    # Generate the fresh HTML report
    reporter = HTMLReporter(config)
    # We want to open the browser
    reporter.open_browser = True
    new_html = reporter.generate(new_analysis)
    print(f"Successfully generated new report: {new_html}")

if __name__ == "__main__":
    render_last()

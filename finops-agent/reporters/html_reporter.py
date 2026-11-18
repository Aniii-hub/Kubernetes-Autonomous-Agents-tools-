"""
HTML Report Generator using Jinja2.
"""

import os
import json
import datetime
import webbrowser
from pathlib import Path
from jinja2 import Environment, FileSystemLoader
from rich.console import Console

console = Console()
TEMPLATE_DIR = Path(__file__).parent.parent / "templates"


class HTMLReporter:
    def __init__(self, config: dict):
        self.output_dir = Path(config["report"]["output_dir"])
        self.open_browser = config["report"].get("open_in_browser", True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.env = Environment(loader=FileSystemLoader(str(TEMPLATE_DIR)))

    def generate(self, analysis: dict) -> Path:
        template = self.env.get_template("report.html")
        html = template.render(
            findings=analysis["findings"],
            total_savings=analysis["total_savings"],
            analyzed_at=analysis["analyzed_at"],
            llm_executive_summary=analysis.get("llm_executive_summary", ""),
            llm_insights=analysis.get("llm_insights", []),
            llm_total_savings=analysis.get("llm_total_savings", 0),
            total_cluster_cost=analysis.get("total_cluster_cost", 0),
            total_aws_cost=analysis.get("total_aws_cost", 0),
            cluster_optimization_plans=analysis.get("cluster_optimization_plans", []),
            cluster_plans=analysis.get("cluster_plans", []),
        )

        ts = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        report_path = self.output_dir / f"finops_report_{ts}.html"
        report_path.write_text(html, encoding="utf-8")

        # Also save raw JSON
        json_path = self.output_dir / f"finops_report_{ts}.json"
        json_path.write_text(json.dumps(analysis, indent=2, default=str), encoding="utf-8")

        # Also save cached_data.json
        cache_data = {
            "aws": analysis.get("_aws_data", {}),
            "grafana": analysis.get("_grafana_data", {}),
            "analysis": analysis
        }
        try:
            (self.output_dir / "cached_data.json").write_text(json.dumps(cache_data, indent=2, default=str), encoding="utf-8")
            console.print(f"[green]📄 Cache Data:[/green] {self.output_dir / 'cached_data.json'}")
        except Exception as ce:
            console.print(f"[yellow]⚠ Failed to write cached_data.json: {ce}[/yellow]")

        console.print(f"[green]📄 HTML Report:[/green] {report_path}")
        console.print(f"[green]📄 JSON Data:[/green]  {json_path}")

        if self.open_browser:
            webbrowser.open(report_path.resolve().as_uri())

        return report_path

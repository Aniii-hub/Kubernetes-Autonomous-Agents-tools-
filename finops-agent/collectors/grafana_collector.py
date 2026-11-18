"""
Grafana / Prometheus Collector.
Uses Grafana HTTP API with username/password auth.
All queries are READ-ONLY.
"""

import requests
import datetime
import time
from rich.console import Console

console = Console()


class GrafanaCollector:
    def __init__(self, config: dict, cluster_name: str = None, url: str = None, username: str = None, password: str = None):
        self.cluster_name = cluster_name
        # cluster-level url/username/password always take priority;
        # fall back to top-level grafana: block only if present (optional)
        grafana_cfg = config.get("grafana", {})
        self.base_url = (url or grafana_cfg.get("url", "")).rstrip("/")

        if not self.base_url:
            console.print(f"[red]✗ No Grafana URL configured for {cluster_name} — skipping[/red]")
            self.base_url = None

        # For localhost URLs (port-forward), verify the port is actually open
        if self.base_url and ("localhost" in self.base_url or "127.0.0.1" in self.base_url):
            import socket
            from urllib.parse import urlparse
            parsed = urlparse(self.base_url)
            port = parsed.port or 80
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.5)
            try:
                s.connect(("127.0.0.1", port))
                console.print(f"  [dim]✓ Port-forward active on {self.base_url} for {cluster_name}[/dim]")
            except Exception:
                console.print(f"  [yellow]⚠ Port-forward NOT active on {self.base_url} for {cluster_name} — skipping[/yellow]")
                self.base_url = None
            finally:
                s.close()

        self.username = username or grafana_cfg.get("username", "admin")
        self.password = password or grafana_cfg.get("password", "")
        self.lookback_days = config.get("analysis", {}).get("lookback_days", 7)
        self.ds_uid = grafana_cfg.get("prometheus_datasource_uid", "") if not url else ""
        self.session = requests.Session()
        self.session.auth = (self.username, self.password)
        self.session.headers.update({"Content-Type": "application/json"})

    def _check_connection(self) -> bool:
        """Verify Grafana credentials and connectivity."""
        try:
            resp = self.session.get(f"{self.base_url}/api/health", timeout=10)
            resp.raise_for_status()
            return True
        except Exception as e:
            console.print(f"[red]✗ Cannot connect to Grafana at {self.base_url}: {e}[/red]")
            return False

    def _get_prometheus_uid(self) -> str:
        """Auto-detect the Prometheus datasource UID."""
        if self.ds_uid:
            return self.ds_uid
        try:
            resp = self.session.get(f"{self.base_url}/api/datasources", timeout=10)
            resp.raise_for_status()
            for ds in resp.json():
                if ds["type"] in ("prometheus", "victoriametrics-datasource"):
                    uid = ds["uid"]
                    console.print(f"  [dim]Auto-detected Prometheus datasource: {ds['name']} (uid={uid})[/dim]")
                    return uid
        except Exception as e:
            console.print(f"[yellow]⚠ Could not auto-detect Prometheus datasource: {e}[/yellow]")
        return ""

    def _get_loki_uid(self) -> str:
        """Auto-detect the Loki datasource UID."""
        return ""

    def _query_prometheus(self, uid: str, query: str, start: int, end: int, step: str = "1h") -> dict:
        """Execute a range query against Prometheus via Grafana proxy."""
        url = f"{self.base_url}/api/datasources/proxy/uid/{uid}/api/v1/query_range"
        params = {"query": query, "start": start, "end": end, "step": step}
        try:
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json().get("data", {}).get("result", [])
        except Exception as e:
            console.print(f"[yellow]⚠ Query failed [{query[:60]}...]: {e}[/yellow]")
            return []

    def _query_instant(self, uid: str, query: str) -> dict:
        """Execute an instant query."""
        url = f"{self.base_url}/api/datasources/proxy/uid/{uid}/api/v1/query"
        params = {"query": query, "time": int(time.time())}
        try:
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json().get("data", {}).get("result", [])
        except Exception as e:
            console.print(f"[yellow]⚠ Instant query failed [{query[:60]}...]: {e}[/yellow]")
            return []

    def _query_loki(self, uid: str, query: str) -> dict:
        """Execute an instant query or query_range for Loki."""
        url = f"{self.base_url}/api/datasources/proxy/uid/{uid}/loki/api/v1/query"
        params = {"query": query, "time": int(time.time()) * 1000000000}  # Loki expects nanoseconds
        try:
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json().get("data", {}).get("result", [])
        except Exception as e:
            console.print(f"[yellow]⚠ Loki query failed [{query[:60]}...]: {e}[/yellow]")
            return []

    def collect_all(self) -> dict:
        console.print("[bold cyan]📊 Collecting Grafana/Prometheus metrics...[/bold cyan]")

        # Port-forward was unavailable — skip this cluster
        if not self.base_url:
            return {"error": "Port-forward not active — cluster skipped", "metrics": {}}

        if not self._check_connection():
            return {"error": "Could not connect to Grafana", "metrics": {}}

        uid = self._get_prometheus_uid()
        if not uid:
            console.print("[red]✗ No Prometheus datasource found. Skipping metrics.[/red]")
            return {"error": "No Prometheus datasource", "metrics": {}}

        end = int(time.time())
        start = end - (self.lookback_days * 86400)

        metrics = {}

        # ── CPU ──────────────────────────────────────────────────────────────
        console.print("  [dim]Fetching CPU metrics...[/dim]")

        # Actual CPU usage per pod (7d average)
        metrics["cpu_actual_avg"] = self._query_instant(uid,
            'avg by (pod, namespace) ('
            '  avg_over_time(rate(container_cpu_usage_seconds_total'
            '  {container!="", container!="POD"}[5m])[7d:5m])'
            ')'
        )

        # CPU requests per pod
        metrics["cpu_requests"] = self._query_instant(uid,
            'sum by (pod, namespace) ('
            '  kube_pod_container_resource_requests{resource="cpu", container!=""}'
            ')'
        )

        # CPU limits per pod
        metrics["cpu_limits"] = self._query_instant(uid,
            'sum by (pod, namespace) ('
            '  kube_pod_container_resource_limits{resource="cpu", container!=""}'
            ')'
        )

        # Peak CPU per pod (max in 7d)
        metrics["cpu_peak"] = self._query_instant(uid,
            'max by (pod, namespace) ('
            '  max_over_time(rate(container_cpu_usage_seconds_total'
            '  {container!="", container!="POD"}[5m])[7d:5m])'
            ')'
        )

        # Off-hours CPU (simple 24h average — avoids Prometheus 'offset 0s' parse errors)
        metrics["cpu_night"] = self._query_instant(uid,
            'avg by (pod, namespace) ('
            '  avg_over_time(rate(container_cpu_usage_seconds_total'
            '  {container!="", container!="POD"}[5m])[24h:5m])'
            ')'
        )

        # CPU Throttling
        metrics["cpu_throttling"] = self._query_instant(uid,
            'sum by (pod, namespace) ('
            '  rate(container_cpu_cfs_throttled_seconds_total{container!=""}[7d])'
            ')'
        )

        # OOM Kills
        metrics["oom_kills"] = self._query_instant(uid,
            'sum by (pod, namespace) ('
            '  kube_pod_container_status_terminated_reason{reason="OOMKilled"}'
            ')'
        )

        # ── Memory ───────────────────────────────────────────────────────────
        console.print("  [dim]Fetching Memory metrics...[/dim]")

        # Actual memory usage per pod
        metrics["memory_actual_avg"] = self._query_instant(uid,
            'avg by (pod, namespace) ('
            '  avg_over_time(container_memory_working_set_bytes'
            '  {container!="", container!="POD"}[7d])'
            ')'
        )

        # Memory requests per pod
        metrics["memory_requests"] = self._query_instant(uid,
            'sum by (pod, namespace) ('
            '  kube_pod_container_resource_requests{resource="memory", container!=""}'
            ')'
        )

        # Memory limits per pod
        metrics["memory_limits"] = self._query_instant(uid,
            'sum by (pod, namespace) ('
            '  kube_pod_container_resource_limits{resource="memory", container!=""}'
            ')'
        )

        # Peak memory
        metrics["memory_peak"] = self._query_instant(uid,
            'max by (pod, namespace) ('
            '  max_over_time(container_memory_working_set_bytes'
            '  {container!="", container!="POD"}[7d])'
            ')'
        )

        # Pod metadata mapping
        metrics["pod_info"] = self._query_instant(uid, 'kube_pod_info')

        # ── Node Utilization ─────────────────────────────────────────────────
        console.print("  [dim]Fetching Node and Metadata metrics...[/dim]")

        metrics["node_cpu_utilization"] = self._query_instant(uid,
            'avg by (node) ('
            '  rate(node_cpu_seconds_total{mode!="idle"}[7d])'
            ')'
        )

        metrics["node_memory_utilization"] = self._query_instant(uid,
            'avg by (node, instance) ('
            '  (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)'
            '  / node_memory_MemTotal_bytes'
            ')'
        )

        # ── Network (for idle detection) ─────────────────────────────────────
        console.print("  [dim]Fetching Network metrics...[/dim]")

        metrics["network_transmit_avg"] = self._query_instant(uid,
            'avg by (pod, namespace) ('
            '  rate(container_network_transmit_bytes_total{container!=""}[7d])'
            ')'
        )

        # ── Scale-to-zero: night traffic (12AM-8AM) ──────────────────────────
        metrics["night_network"] = self._query_range(uid,
            'sum by (pod, namespace) ('
            '  rate(container_network_transmit_bytes_total[1h])'
            ')',
            start, end, step="1h"
        )

        # ── Loki Log Metrics ──────────────────────────────────────────────────
        loki_uid = self._get_loki_uid()
        if loki_uid:
            console.print("  [dim]Fetching Loki log volume and error metrics...[/dim]")
            log_vol = self._query_loki(loki_uid, 'sum by (namespace, container) (count_over_time({namespace=~".+"}[7d]))')
            if not log_vol:
                log_vol = self._query_loki(loki_uid, 'sum by (kubernetes_namespace, kubernetes_container_name) (count_over_time({kubernetes_namespace=~".+"}[7d]))')
                for entry in log_vol:
                    m = entry.get("metric", {})
                    if "kubernetes_namespace" in m:
                        m["namespace"] = m.pop("kubernetes_namespace")
                    if "kubernetes_container_name" in m:
                        m["container"] = m.pop("kubernetes_container_name")
            metrics["loki_log_volume"] = log_vol

            err_vol = self._query_loki(loki_uid, 'sum by (namespace, container) (count_over_time({namespace=~".+"} |~ "(?i)error|exception|fail"[7d]))')
            if not err_vol:
                err_vol = self._query_loki(loki_uid, 'sum by (kubernetes_namespace, kubernetes_container_name) (count_over_time({kubernetes_namespace=~".+"} |~ "(?i)error|exception|fail"[7d]))')
                for entry in err_vol:
                    m = entry.get("metric", {})
                    if "kubernetes_namespace" in m:
                        m["namespace"] = m.pop("kubernetes_namespace")
                    if "kubernetes_container_name" in m:
                        m["container"] = m.pop("kubernetes_container_name")
            metrics["loki_error_volume"] = err_vol

        # Tag metrics with cluster name if specified
        if self.cluster_name:
            for key, val_list in metrics.items():
                if isinstance(val_list, list):
                    for entry in val_list:
                        if isinstance(entry, dict) and "metric" in entry:
                            entry["metric"]["cluster"] = self.cluster_name

        console.print(
            f"[green]✅ Grafana metrics collected:[/green] "
            f"{sum(len(v) for v in metrics.values() if isinstance(v, list))} metric series"
        )
        return {"uid": uid, "loki_uid": loki_uid, "metrics": metrics}

    def _query_range(self, uid: str, query: str, start: int, end: int, step: str = "1h") -> list:
        return self._query_prometheus(uid, query, start, end, step)

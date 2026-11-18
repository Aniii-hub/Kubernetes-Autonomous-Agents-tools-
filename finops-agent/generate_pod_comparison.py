import json
import re
import csv
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

import server

reports_dir = Path("reports")
cached = json.load(open(reports_dir / "cached_data.json", encoding="utf-8"))
server.cached_data = cached

workloads = server.get_workloads()
recs = server.get_recommendations()

qa_pods = workloads.get("medvista-k8s-v2-qa-sit", [])
dev_pods = workloads.get("medvista-global-dev", [])

qa_recs_map = {}
for r in recs.get("medvista-k8s-v2-qa-sit", []):
    qa_recs_map[(r.get("pod"), r.get("namespace"))] = r

dev_recs_map = {}
for r in recs.get("medvista-global-dev", []):
    dev_recs_map[(r.get("pod"), r.get("namespace"))] = r

def clean_name(p_name):
    base = re.sub(r'-[a-z0-9]{8,10}-[a-z0-9]{5}$', '', p_name)
    base = re.sub(r'-[a-z0-9]{5}$', '', base)
    return base

# ── 1. Create Flat List of ALL Pods with explicit Cluster Name ─────────────
all_flat_pods = []

for p in qa_pods:
    pod_name = p.get("pod", "")
    ns = p.get("namespace", "")
    wl = clean_name(pod_name)
    r = qa_recs_map.get((pod_name, ns)) or qa_recs_map.get((wl, ns))
    rec_str = f"Resize CPU: {r.get('cpu_rec')}, Mem: {r.get('mem_rec')} (Save {r.get('savings')})" if r else "Optimal (No action required)"
    
    all_flat_pods.append({
        "cluster": "medvista-k8s-v2-qa-sit",
        "namespace": ns,
        "workload": wl,
        "pod_name": pod_name,
        "node": p.get("node", "N/A"),
        "cpu_req": p.get("cpu_req", "0m"),
        "cpu_lmt": p.get("cpu_lmt", "0m"),
        "cpu_used": p.get("cpu_used", "0m"),
        "mem_req": p.get("mem_req", "0Mi"),
        "mem_lmt": p.get("mem_lmt", "0Mi"),
        "mem_used": p.get("mem_used", "0Mi"),
        "recommendation": rec_str
    })

for p in dev_pods:
    pod_name = p.get("pod", "")
    ns = p.get("namespace", "")
    wl = clean_name(pod_name)
    r = dev_recs_map.get((pod_name, ns)) or dev_recs_map.get((wl, ns))
    rec_str = f"Resize CPU: {r.get('cpu_rec')}, Mem: {r.get('mem_rec')} (Save {r.get('savings')})" if r else "Optimal (No action required)"
    
    all_flat_pods.append({
        "cluster": "medvista-global-dev",
        "namespace": ns,
        "workload": wl,
        "pod_name": pod_name,
        "node": p.get("node", "N/A"),
        "cpu_req": p.get("cpu_req", "0m"),
        "cpu_lmt": p.get("cpu_lmt", "0m"),
        "cpu_used": p.get("cpu_used", "0m"),
        "mem_req": p.get("mem_req", "0Mi"),
        "mem_lmt": p.get("mem_lmt", "0Mi"),
        "mem_used": p.get("mem_used", "0Mi"),
        "recommendation": rec_str
    })

# Write Flat List CSV
csv_flat_path = reports_dir / "all_pods_qa_vs_dev.csv"
with open(csv_flat_path, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=[
        "cluster", "namespace", "workload", "pod_name", "node",
        "cpu_req", "cpu_lmt", "cpu_used", "mem_req", "mem_lmt", "mem_used", "recommendation"
    ])
    writer.writeheader()
    writer.writerows(all_flat_pods)

# ── 2. Create Side-by-Side Comparison List ─────────────────────────────────
qa_dict = {}
for p in qa_pods:
    key = (clean_name(p["pod"]), p["namespace"])
    qa_dict.setdefault(key, []).append(p)

dev_dict = {}
for p in dev_pods:
    key = (clean_name(p["pod"]), p["namespace"])
    dev_dict.setdefault(key, []).append(p)

all_keys = sorted(list(set(qa_dict.keys()) | set(dev_dict.keys())), key=lambda x: (x[1], x[0]))

side_rows = []
for wl_name, ns in all_keys:
    q_list = qa_dict.get((wl_name, ns), [])
    d_list = dev_dict.get((wl_name, ns), [])
    
    if q_list:
        q_p = q_list[0]
        q_cpu_req, q_cpu_used = q_p.get("cpu_req", "0m"), q_p.get("cpu_used", "0m")
        q_mem_req, q_mem_used = q_p.get("mem_req", "0Mi"), q_p.get("mem_used", "0Mi")
        r_q = qa_recs_map.get((q_p["pod"], ns)) or qa_recs_map.get((wl_name, ns))
        q_rec = f"Resize CPU to {r_q.get('cpu_rec')}, Mem to {r_q.get('mem_rec')} ({r_q.get('savings')})" if r_q else "Optimal"
    else:
        q_cpu_req = q_cpu_used = q_mem_req = q_mem_used = "N/A"
        q_rec = "Not Deployed in QA-SIT"

    if d_list:
        d_p = d_list[0]
        d_cpu_req, d_cpu_used = d_p.get("cpu_req", "0m"), d_p.get("cpu_used", "0m")
        d_mem_req, d_mem_used = d_p.get("mem_req", "0Mi"), d_p.get("mem_used", "0Mi")
        r_d = dev_recs_map.get((d_p["pod"], ns)) or dev_recs_map.get((wl_name, ns))
        d_rec = f"Resize CPU to {r_d.get('cpu_rec')}, Mem to {r_d.get('mem_rec')} ({r_d.get('savings')})" if r_d else "Optimal"
    else:
        d_cpu_req = d_cpu_used = d_mem_req = d_mem_used = "N/A"
        d_rec = "Not Deployed in Dev"

    side_rows.append({
        "workload": wl_name,
        "namespace": ns,
        "qa_cpu_req": q_cpu_req,
        "qa_cpu_used": q_cpu_used,
        "qa_mem_req": q_mem_req,
        "qa_mem_used": q_mem_used,
        "qa_recommendation": q_rec,
        "dev_cpu_req": d_cpu_req,
        "dev_cpu_used": d_cpu_used,
        "dev_mem_req": d_mem_req,
        "dev_mem_used": d_mem_used,
        "dev_recommendation": d_rec
    })

# Write Side-by-Side CSV
csv_side_path = reports_dir / "side_by_side_comparison_qa_vs_dev.csv"
with open(csv_side_path, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=[
        "workload", "namespace",
        "qa_cpu_req", "qa_cpu_used", "qa_mem_req", "qa_mem_used", "qa_recommendation",
        "dev_cpu_req", "dev_cpu_used", "dev_mem_req", "dev_mem_used", "dev_recommendation"
    ])
    writer.writeheader()
    writer.writerows(side_rows)

# ── 3. Build Multi-Tab Excel Workbook ──────────────────────────────────────
wb = openpyxl.Workbook()

header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
header_font = Font(name="Segoe UI", size=10, bold=True, color="FFFFFF")

# Tab 1: All Pods List (With Explicit Cluster Column)
ws1 = wb.active
ws1.title = "All Pods (by Cluster)"

ws1.append([
    "Cluster Name", "Namespace", "Workload", "Pod Name", "Node Placement",
    "CPU Req", "CPU Limit", "CPU Used", "Mem Req", "Mem Limit", "Mem Used", "FinOps Recommendation"
])
for cell in ws1[1]:
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal="center", vertical="center")

for p in all_flat_pods:
    ws1.append([
        p["cluster"], p["namespace"], p["workload"], p["pod_name"], p["node"],
        p["cpu_req"], p["cpu_lmt"], p["cpu_used"], p["mem_req"], p["mem_lmt"], p["mem_used"], p["recommendation"]
    ])

# Tab 2: Side-by-Side Comparison
ws2 = wb.create_sheet(title="Side-by-Side Comparison")
ws2.append([
    "Workload Identity", "Namespace",
    "QA-SIT CPU Req", "QA-SIT CPU Used", "QA-SIT Mem Req", "QA-SIT Mem Used", "QA-SIT Recommendation",
    "Dev CPU Req", "Dev CPU Used", "Dev Mem Req", "Dev Mem Used", "Dev Recommendation"
])
for cell in ws2[1]:
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal="center", vertical="center")

for r in side_rows:
    ws2.append([
        r["workload"], r["namespace"],
        r["qa_cpu_req"], r["qa_cpu_used"], r["qa_mem_req"], r["qa_mem_used"], r["qa_recommendation"],
        r["dev_cpu_req"], r["dev_cpu_used"], r["dev_mem_req"], r["dev_mem_used"], r["dev_recommendation"]
    ])

excel_path = reports_dir / "pod_level_comparison_qa_vs_dev.xlsx"
wb.save(excel_path)

print(f"Report generated successfully!")
print(f"- Total Flat Pods: {len(all_flat_pods)} across 2 clusters")
print(f"- Total Workloads Compared: {len(side_rows)}")
print(f"- Files created:")
print(f"  * {excel_path}")
print(f"  * {csv_flat_path}")
print(f"  * {csv_side_path}")

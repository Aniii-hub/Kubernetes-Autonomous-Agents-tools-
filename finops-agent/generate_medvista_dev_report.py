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

dev_cluster = "medvista-global-dev"
dev_pods = workloads.get(dev_cluster, [])

dev_recs_map = {}
for r in recs.get(dev_cluster, []):
    dev_recs_map[(r.get("pod"), r.get("namespace"))] = r

def clean_name(p_name):
    base = re.sub(r'-[a-z0-9]{8,10}-[a-z0-9]{5}$', '', p_name)
    base = re.sub(r'-[a-z0-9]{5}$', '', base)
    return base

# ── 1. Create Flat List of Medvista Global Dev Pods ─────────────
dev_flat_pods = []

for p in dev_pods:
    pod_name = p.get("pod", "")
    ns = p.get("namespace", "")
    wl = clean_name(pod_name)
    r = dev_recs_map.get((pod_name, ns)) or dev_recs_map.get((wl, ns))
    rec_str = f"Resize CPU: {r.get('cpu_rec')}, Mem: {r.get('mem_rec')} (Save {r.get('savings')})" if r else "Optimal (No action required)"
    
    dev_flat_pods.append({
        "cluster": dev_cluster,
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

# Write CSV
csv_path = reports_dir / "medvista_dev_pods.csv"
with open(csv_path, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=[
        "cluster", "namespace", "workload", "pod_name", "node",
        "cpu_req", "cpu_lmt", "cpu_used", "mem_req", "mem_lmt", "mem_used", "recommendation"
    ])
    writer.writeheader()
    writer.writerows(dev_flat_pods)

print(f"Generated {csv_path} with {len(dev_flat_pods)} pods.")

# ── 2. Create Formatted Excel Workbook ─────────────────────────────────
wb = openpyxl.Workbook()

# Setup Styles
font_title = Font(name="Calibri", size=14, bold=True, color="1F497D")
font_sub = Font(name="Calibri", size=10, italic=True, color="595959")
font_header = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
font_bold = Font(name="Calibri", size=11, bold=True)
font_regular = Font(name="Calibri", size=10)

fill_dark_blue = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
fill_light_blue = PatternFill(start_color="DCE6F1", end_color="DCE6F1", fill_type="solid")
fill_zebra = PatternFill(start_color="F2F5F8", end_color="F2F5F8", fill_type="solid")
fill_rec = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")

thin_border_side = Side(style='thin', color='D9D9D9')
border_cell = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thin_border_side)

align_center = Alignment(horizontal="center", vertical="center")
align_left = Alignment(horizontal="left", vertical="center")
align_right = Alignment(horizontal="right", vertical="center")

# Sheet 1: All Pods Inventory
ws1 = wb.active
ws1.title = "Medvista Dev Pod Inventory"
ws1.views.sheetView[0].showGridLines = True

ws1.append(["MEDVISTA-GLOBAL-DEV - Pod Resource Usage & Recommendation Report"])
ws1.append(["Generated for medvista-global-dev cluster after new service deployments"])
ws1.append([])

headers1 = ["Cluster", "Namespace", "Workload / Service", "Pod Name", "Node", "CPU Req", "CPU Limit", "CPU Used", "Mem Req", "Mem Limit", "Mem Used", "Recommendation & Action"]
ws1.append(headers1)

ws1.cell(row=1, column=1).font = font_title
ws1.cell(row=2, column=1).font = font_sub

for col_num in range(1, len(headers1) + 1):
    cell = ws1.cell(row=4, column=col_num)
    cell.font = font_header
    cell.fill = fill_dark_blue
    cell.alignment = align_center

row_idx = 5
for row_data in dev_flat_pods:
    r_vals = [
        row_data["cluster"], row_data["namespace"], row_data["workload"],
        row_data["pod_name"], row_data["node"], row_data["cpu_req"],
        row_data["cpu_lmt"], row_data["cpu_used"], row_data["mem_req"],
        row_data["mem_lmt"], row_data["mem_used"], row_data["recommendation"]
    ]
    ws1.append(r_vals)
    current_row = ws1[row_idx]
    
    use_zebra = (row_idx % 2 == 0)
    for c_idx, cell in enumerate(current_row, 1):
        cell.font = font_regular
        cell.border = border_cell
        if use_zebra:
            cell.fill = fill_zebra
        if c_idx in [6, 7, 8, 9, 10, 11]:
            cell.alignment = align_right
        elif c_idx in [1, 2, 5]:
            cell.alignment = align_center
        else:
            cell.alignment = align_left
        
        if c_idx == 12 and "Resize" in str(cell.value):
            cell.fill = fill_rec
            cell.font = font_bold

    row_idx += 1

# Auto-fit columns
for ws in [ws1]:
    for col in ws.columns:
        max_len = 0
        col_letter = openpyxl.utils.get_column_letter(col[0].column)
        for cell in col:
            if cell.row < 4:
                continue
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = min(max(max_len + 3, 12), 65)

excel_path = reports_dir / "medvista_dev_pod_analysis.xlsx"
wb.save(excel_path)
print(f"Generated {excel_path} successfully.")

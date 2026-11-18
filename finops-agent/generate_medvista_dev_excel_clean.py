import json
import re
import csv
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

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

dev_rows = []
for p in dev_pods:
    pod_name = p.get("pod", "")
    ns = p.get("namespace", "")
    wl = clean_name(pod_name)
    r = dev_recs_map.get((pod_name, ns)) or dev_recs_map.get((wl, ns))
    
    cpu_req = p.get("cpu_req", "0m")
    cpu_lmt = p.get("cpu_lmt", "0m")
    cpu_used = p.get("cpu_used", "0m")
    
    mem_req = p.get("mem_req", "0Mi")
    mem_lmt = p.get("mem_lmt", "0Mi")
    mem_used = p.get("mem_used", "0Mi")
    
    if r:
        cpu_rec = r.get("cpu_rec", cpu_req)
        mem_rec = r.get("mem_rec", mem_req)
        raw_sav = str(r.get("savings", "0")).replace("$", "").replace("/mo", "").strip()
        try:
            savings = float(raw_sav)
        except ValueError:
            savings = 0.0
        action = f"Resize CPU from {cpu_req} to {cpu_rec}, Mem from {mem_req} to {mem_rec}"
        status = "Action Required"
    else:
        cpu_rec = cpu_req
        mem_rec = mem_req
        savings = 0.0
        action = "Optimal (No action required)"
        status = "Optimal"
        
    dev_rows.append({
        "cluster": dev_cluster,
        "namespace": ns,
        "pod_name": pod_name,
        "workload": wl,
        "node": p.get("node", "N/A"),
        "cpu_req": cpu_req,
        "cpu_lmt": cpu_lmt,
        "cpu_used": cpu_used,
        "cpu_rec": cpu_rec,
        "mem_req": mem_req,
        "mem_lmt": mem_lmt,
        "mem_used": mem_used,
        "mem_rec": mem_rec,
        "savings": savings,
        "status": status,
        "action": action
    })

# ── 1. Create CSV File ──────────────────────────────────────────────────────
csv_file = reports_dir / "medvista_dev_pod_metrics_and_recommendations.csv"
with open(csv_file, "w", newline="", encoding="utf-8") as f:
    fieldnames = [
        "cluster", "namespace", "pod_name", "workload", "node",
        "cpu_req", "cpu_lmt", "cpu_used", "cpu_rec",
        "mem_req", "mem_lmt", "mem_used", "mem_rec",
        "savings", "status", "action"
    ]
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(dev_rows)

print(f"Generated CSV: {csv_file}")

# ── 2. Create Formatted Excel Workbook ──────────────────────────────────────
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Medvista Dev Pod Sizing"
ws.views.sheetView[0].showGridLines = True

# Style setup
font_title = Font(name="Calibri", size=15, bold=True, color="1F497D")
font_sub = Font(name="Calibri", size=10, italic=True, color="595959")
font_header = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
font_bold = Font(name="Calibri", size=11, bold=True)
font_regular = Font(name="Calibri", size=10)

fill_dark_navy = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
fill_zebra = PatternFill(start_color="F9FAFB", end_color="F9FAFB", fill_type="solid")
fill_warn = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")
fill_green = PatternFill(start_color="E2EFDA", end_color="E2EFDA", fill_type="solid")

thin_border_side = Side(style='thin', color='D9D9D9')
border_cell = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thin_border_side)

align_center = Alignment(horizontal="center", vertical="center")
align_left = Alignment(horizontal="left", vertical="center")
align_right = Alignment(horizontal="right", vertical="center")

# Title Header
ws.cell(row=1, column=1, value="MEDVISTA-GLOBAL-DEV - Pod Allotted vs Used vs Recommended CPU & Memory Report").font = font_title
ws.cell(row=2, column=1, value="Contains Pod Name, Namespace, Allotted CPU/Memory, Used CPU/Memory, Recommendations & Savings for 104 Pods").font = font_sub

headers = [
    "Cluster", "Namespace", "Pod Name", "Workload / Service", "Node",
    "Allotted CPU (Req)", "CPU Limit", "Used CPU", "CPU Rec",
    "Allotted Mem (Req)", "Mem Limit", "Used Mem", "Mem Rec",
    "Est. Savings ($/mo)", "Status", "Recommended Action"
]

ws.append([])
ws.append(headers)

for col_idx in range(1, len(headers) + 1):
    cell = ws.cell(row=4, column=col_idx)
    cell.font = font_header
    cell.fill = fill_dark_navy
    cell.alignment = align_center

r_idx = 5
for row_data in dev_rows:
    r_vals = [
        row_data["cluster"], row_data["namespace"], row_data["pod_name"],
        row_data["workload"], row_data["node"], row_data["cpu_req"],
        row_data["cpu_lmt"], row_data["cpu_used"], row_data["cpu_rec"],
        row_data["mem_req"], row_data["mem_lmt"], row_data["mem_used"],
        row_data["mem_rec"], row_data["savings"], row_data["status"],
        row_data["action"]
    ]
    ws.append(r_vals)
    curr_row = ws[r_idx]
    
    is_zebra = (r_idx % 2 == 0)
    for c_idx, cell in enumerate(curr_row, 1):
        cell.font = font_regular
        cell.border = border_cell
        if is_zebra:
            cell.fill = fill_zebra
            
        if c_idx in [6, 7, 8, 9, 10, 11, 12, 13]:
            cell.alignment = align_right
        elif c_idx in [1, 2, 5, 15]:
            cell.alignment = align_center
        elif c_idx == 14:
            cell.alignment = align_right
            cell.number_format = '$#,##0.00'
            cell.font = font_bold
        else:
            cell.alignment = align_left
            
        if c_idx == 15:
            if cell.value == "Action Required":
                cell.fill = fill_warn
                cell.font = font_bold
            else:
                cell.fill = fill_green

    r_idx += 1

# Auto-adjust Column Widths
for col in ws.columns:
    max_len = 0
    col_letter = get_column_letter(col[0].column)
    for cell in col:
        if cell.row < 4:
            continue
        val_str = str(cell.value or '')
        if len(val_str) > max_len:
            max_len = len(val_str)
    ws.column_dimensions[col_letter].width = min(max(max_len + 3, 12), 65)

excel_file = reports_dir / "medvista_dev_pod_metrics_and_recommendations.xlsx"
wb.save(excel_file)
print(f"Generated Excel: {excel_file}")

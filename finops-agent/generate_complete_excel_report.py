import json
import re
import csv
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

import server

reports_dir = Path("reports")

# Load latest report JSON and cached_data
finops_json_file = sorted(reports_dir.glob("finops_report_*.json"), reverse=True)[0]
report_data = json.load(open(finops_json_file, encoding="utf-8"))
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

# Prepare flat list of dev pods
dev_flat_pods = []
for p in dev_pods:
    pod_name = p.get("pod", "")
    ns = p.get("namespace", "")
    wl = clean_name(pod_name)
    r = dev_recs_map.get((pod_name, ns)) or dev_recs_map.get((wl, ns))
    
    if r:
        rec_action = f"Resize CPU: {r.get('cpu_rec')}, Mem: {r.get('mem_rec')}"
        savings = float(str(r.get('savings', '0')).replace('$', '').replace('/mo', '').strip() or 0)
        status = "Optimization Needed"
    else:
        rec_action = "Optimal (No action required)"
        savings = 0.0
        status = "Optimal"
        
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
        "status": status,
        "recommendation": rec_action,
        "savings": savings
    })

# ── Create OpenPyXL Workbook ────────────────────────────────────────────────
wb = openpyxl.Workbook()

# Style Palette
font_title = Font(name="Calibri", size=16, bold=True, color="1F497D")
font_subtitle = Font(name="Calibri", size=11, italic=True, color="595959")
font_sec_hdr = Font(name="Calibri", size=12, bold=True, color="1F497D")
font_tbl_hdr = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
font_bold = Font(name="Calibri", size=11, bold=True)
font_regular = Font(name="Calibri", size=10)
font_code = Font(name="Consolas", size=9)

fill_dark_navy = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
fill_soft_blue = PatternFill(start_color="DCE6F1", end_color="DCE6F1", fill_type="solid")
fill_zebra = PatternFill(start_color="F9FAFB", end_color="F9FAFB", fill_type="solid")
fill_warn = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")
fill_green = PatternFill(start_color="E2EFDA", end_color="E2EFDA", fill_type="solid")

border_thin_side = Side(style='thin', color='D9D9D9')
border_cell = Border(left=border_thin_side, right=border_thin_side, top=border_thin_side, bottom=border_thin_side)
border_header = Border(left=border_thin_side, right=border_thin_side, top=border_thin_side, bottom=border_thin_side)

align_center = Alignment(horizontal="center", vertical="center")
align_left = Alignment(horizontal="left", vertical="center")
align_right = Alignment(horizontal="right", vertical="center")

# ==============================================================================
# TAB 1: EXECUTIVE SUMMARY
# ==============================================================================
ws_sum = wb.active
ws_sum.title = "Executive Summary"
ws_sum.views.sheetView[0].showGridLines = True

ws_sum.cell(row=1, column=1, value="MEDVISTA-GLOBAL-DEV - EKS FinOps Executive Summary").font = font_title
ws_sum.cell(row=2, column=1, value=f"Generated on {report_data.get('analyzed_at', '2026-08-12')} | Target Cluster: medvista-global-dev").font = font_subtitle

# Key Metrics Cards
metrics_cards = [
    ("Target Cluster Name", dev_cluster),
    ("Total Cluster Monthly Cost", f"${report_data.get('total_cluster_cost', 500.49):,.2f}/mo"),
    ("Total Identified Monthly Savings", f"${report_data.get('total_savings', 82.25):,.2f}/mo"),
    ("Potential Cost Reduction %", f"{(report_data.get('total_savings', 82.25)/report_data.get('total_cluster_cost', 500.49))*100:.1f}%"),
    ("Total Pods Analyzed", len(dev_flat_pods)),
    ("Total FinOps Recommendations", len(report_data.get("findings", [])))
]

row_i = 4
ws_sum.cell(row=row_i, column=1, value="Key Performance Indicators").font = font_sec_hdr
row_i += 1

ws_sum.cell(row=row_i, column=1, value="Metric").font = font_tbl_hdr
ws_sum.cell(row=row_i, column=1).fill = fill_dark_navy
ws_sum.cell(row=row_i, column=1).alignment = align_center

ws_sum.cell(row=row_i, column=2, value="Value").font = font_tbl_hdr
ws_sum.cell(row=row_i, column=2).fill = fill_dark_navy
ws_sum.cell(row=row_i, column=2).alignment = align_center

row_i += 1
for label, val in metrics_cards:
    c1 = ws_sum.cell(row=row_i, column=1, value=label)
    c2 = ws_sum.cell(row=row_i, column=2, value=val)
    c1.font = font_bold
    c2.font = font_bold
    c1.border = border_cell
    c2.border = border_cell
    c1.alignment = align_left
    c2.alignment = align_right
    if "Savings" in label or "Reduction" in label:
        c1.fill = fill_green
        c2.fill = fill_green
    else:
        c1.fill = fill_soft_blue
        c2.fill = fill_soft_blue
    row_i += 1

row_i += 2
ws_sum.cell(row=row_i, column=1, value="Findings Breakdown by Category").font = font_sec_hdr
row_i += 1

cat_counts = {}
for f in report_data.get("findings", []):
    cat = f.get("category", "Other")
    sav = f.get("monthly_savings", 0)
    if cat not in cat_counts:
        cat_counts[cat] = {"count": 0, "savings": 0.0}
    cat_counts[cat]["count"] += 1
    cat_counts[cat]["savings"] += sav

ws_sum.cell(row=row_i, column=1, value="Category").font = font_tbl_hdr
ws_sum.cell(row=row_i, column=1).fill = fill_dark_navy
ws_sum.cell(row=row_i, column=2, value="Finding Count").font = font_tbl_hdr
ws_sum.cell(row=row_i, column=2).fill = fill_dark_navy
ws_sum.cell(row=row_i, column=3, value="Est. Monthly Savings ($)").font = font_tbl_hdr
ws_sum.cell(row=row_i, column=3).fill = fill_dark_navy

row_i += 1
for cat, data in sorted(cat_counts.items(), key=lambda x: x[1]["savings"], reverse=True):
    c1 = ws_sum.cell(row=row_i, column=1, value=cat)
    c2 = ws_sum.cell(row=row_i, column=2, value=data["count"])
    c3 = ws_sum.cell(row=row_i, column=3, value=round(data["savings"], 2))
    
    c1.font = font_regular
    c2.font = font_regular
    c3.font = font_bold
    c1.border = border_cell
    c2.border = border_cell
    c3.border = border_cell
    
    c1.alignment = align_left
    c2.alignment = align_center
    c3.alignment = align_right
    c3.number_format = '$#,##0.00'
    row_i += 1

# ==============================================================================
# TAB 2: POD RESOURCE & RIGHTSIZING
# ==============================================================================
ws_pods = wb.create_sheet(title="Pod Resource Rightsizing")
ws_pods.views.sheetView[0].showGridLines = True

ws_pods.cell(row=1, column=1, value="MEDVISTA-GLOBAL-DEV - Pod Resource Usage & Rightsizing Recommendations").font = font_title
ws_pods.cell(row=2, column=1, value="Complete Pod Inventory (104 Pods) with Requests, Limits, Actual Usage & Sizing Actions").font = font_subtitle

headers_pods = [
    "Cluster", "Namespace", "Workload / Service", "Pod Name", "Node",
    "CPU Req", "CPU Limit", "CPU Used", "Mem Req", "Mem Limit", "Mem Used",
    "Status", "Recommendation & Action", "Est. Savings ($/mo)"
]

ws_pods.append([])
ws_pods.append(headers_pods)

for col_idx in range(1, len(headers_pods) + 1):
    cell = ws_pods.cell(row=4, column=col_idx)
    cell.font = font_tbl_hdr
    cell.fill = fill_dark_navy
    cell.alignment = align_center

r_idx = 5
for row_data in dev_flat_pods:
    r_vals = [
        row_data["cluster"], row_data["namespace"], row_data["workload"],
        row_data["pod_name"], row_data["node"], row_data["cpu_req"],
        row_data["cpu_lmt"], row_data["cpu_used"], row_data["mem_req"],
        row_data["mem_lmt"], row_data["mem_used"], row_data["status"],
        row_data["recommendation"], row_data["savings"]
    ]
    ws_pods.append(r_vals)
    curr_row = ws_pods[r_idx]
    
    is_zebra = (r_idx % 2 == 0)
    for c_idx, cell in enumerate(curr_row, 1):
        cell.font = font_regular
        cell.border = border_cell
        if is_zebra:
            cell.fill = fill_zebra
            
        if c_idx in [6, 7, 8, 9, 10, 11]:
            cell.alignment = align_right
        elif c_idx in [1, 2, 5, 12]:
            cell.alignment = align_center
        elif c_idx == 14:
            cell.alignment = align_right
            cell.number_format = '$#,##0.00'
            cell.font = font_bold
        else:
            cell.alignment = align_left
            
        if c_idx == 12:
            if cell.value == "Optimization Needed":
                cell.fill = fill_warn
                cell.font = font_bold
            else:
                cell.fill = fill_green

    r_idx += 1

# ==============================================================================
# TAB 3: ALL FINOPS FINDINGS & REMEDIATION
# ==============================================================================
ws_find = wb.create_sheet(title="FinOps Findings & Remediation")
ws_find.views.sheetView[0].showGridLines = True

ws_find.cell(row=1, column=1, value="MEDVISTA-GLOBAL-DEV - All FinOps Cost Optimization Findings").font = font_title
ws_find.cell(row=2, column=1, value="86 Actionable Recommendations with Technical Reasons and Remediation Snippets").font = font_subtitle

headers_find = [
    "No.", "Category", "Resource ID / Name", "Current State", "Suggested Action",
    "Risk", "Reason & Metric Evidence", "Est. Savings ($/mo)", "Remediation Code / Command"
]

ws_find.append([])
ws_find.append(headers_find)

for col_idx in range(1, len(headers_find) + 1):
    cell = ws_find.cell(row=4, column=col_idx)
    cell.font = font_tbl_hdr
    cell.fill = fill_dark_navy
    cell.alignment = align_center

r_idx = 5
for idx, f in enumerate(report_data.get("findings", []), 1):
    res_id = f.get("resource_id") or f.get("name") or "N/A"
    curr_st = f.get("current_state") or "Overprovisioned"
    sug_act = f.get("suggested_action") or "Resize CPU and Memory"
    risk = f.get("risk") or "Low"
    reason = f.get("reason") or ""
    sav = float(f.get("monthly_savings", 0.0))
    
    code = ""
    if f.get("boto3_command"):
        code = f["boto3_command"]
    elif f.get("terraform_snippet"):
        code = f["terraform_snippet"]
    elif f.get("keda_snippet"):
        code = f["keda_snippet"]
    elif f.get("helm_patch"):
        code = f["helm_patch"]
        
    r_vals = [
        idx, f.get("category", "General"), res_id, curr_st, sug_act,
        risk, reason, sav, code
    ]
    ws_find.append(r_vals)
    curr_row = ws_find[r_idx]
    
    is_zebra = (r_idx % 2 == 0)
    for c_idx, cell in enumerate(curr_row, 1):
        cell.font = font_regular
        cell.border = border_cell
        if is_zebra:
            cell.fill = fill_zebra
            
        if c_idx == 1:
            cell.alignment = align_center
        elif c_idx in [2, 6]:
            cell.alignment = align_center
        elif c_idx == 8:
            cell.alignment = align_right
            cell.number_format = '$#,##0.00'
            cell.font = font_bold
        elif c_idx == 9:
            cell.font = font_code
            cell.alignment = align_left
        else:
            cell.alignment = align_left

        if c_idx == 6:
            if str(cell.value).lower() == "high":
                cell.fill = PatternFill(start_color="FCE4D6", end_color="FCE4D6", fill_type="solid")
            elif str(cell.value).lower() == "medium":
                cell.fill = fill_warn

    r_idx += 1

# ==============================================================================
# Auto-fit Column Widths across all Sheets
# ==============================================================================
for sheet in wb.worksheets:
    for col in sheet.columns:
        max_len = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            if cell.row < 4:
                continue
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        sheet.column_dimensions[col_letter].width = min(max(max_len + 3, 12), 70)

# Save Both Files
excel_path1 = reports_dir / "medvista_global_dev_finops_report.xlsx"
excel_path2 = reports_dir / "medvista_dev_pod_analysis.xlsx"

wb.save(excel_path1)
wb.save(excel_path2)

print(f"✅ Generated Excel report: {excel_path1}")
print(f"✅ Generated Excel report: {excel_path2}")

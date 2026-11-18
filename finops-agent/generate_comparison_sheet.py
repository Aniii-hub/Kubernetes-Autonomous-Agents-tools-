import json
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

# Load the cache files
with open("reports/cached_data.json", "r") as f:
    cached1 = json.load(f)

with open("reports-other-account/cached_data.json", "r") as f:
    cached2 = json.load(f)

def get_cluster_metrics(cached, target_cluster):
    # Extract general info
    aws = cached.get("aws", cached.get("_aws_data", {}))
    
    eks_info = aws.get("eks_clusters", [])
    cluster_name = target_cluster
    k8s_version = "1.34"
    region = "ap-south-1"
    
    for c_entry in eks_info:
        c_meta = c_entry.get("cluster", {}) if isinstance(c_entry, dict) else {}
        name = c_meta.get("name", "") if isinstance(c_meta, dict) else c_entry
        if name == target_cluster:
            cluster_name = name
            if isinstance(c_meta, dict):
                k8s_version = c_meta.get("version", k8s_version)
                region = c_meta.get("arn", "").split(":")[3] if c_meta.get("arn") else region
            break
            
    # Filter instances that belong to this EKS cluster
    instances = aws.get("ec2_instances", [])
    cluster_instances = []
    for inst in instances:
        has_tag = False
        for tag in inst.get("Tags", []):
            if tag.get("Key", "").startswith("kubernetes.io/cluster/") and target_cluster in tag.get("Key", ""):
                has_tag = True
                break
        if has_tag:
            cluster_instances.append(inst)
            
    # If no instance matches the EKS tags, fall back to all instances
    if not cluster_instances:
        cluster_instances = instances
        
    node_count = len(cluster_instances)
    instance_type = cluster_instances[0].get("InstanceType", "m6a.xlarge") if cluster_instances else "m6a.xlarge"
    
    # Sizing specs
    cpu_per_node = 4
    mem_per_node = 16
    if "m6a.xlarge" in instance_type:
        cpu_per_node = 4
        mem_per_node = 16
    elif "m6a.large" in instance_type:
        cpu_per_node = 2
        mem_per_node = 8
    elif "t3.xlarge" in instance_type:
        cpu_per_node = 4
        mem_per_node = 16
        
    total_cluster_cpu = node_count * cpu_per_node
    total_cluster_mem = node_count * mem_per_node
    max_pod_capacity = node_count * 58
    
    # Hourly price for ap-south-1
    instance_pricing = {
        "m6a.large": 0.096,
        "m6a.xlarge": 0.192,
        "m6a.2xlarge": 0.384,
        "t3.xlarge": 0.1664,
    }
    hourly_rate = instance_pricing.get(instance_type, 0.192)
    node_monthly_cost = node_count * hourly_rate * 730
    control_plane_cost = 73.00 if node_count > 0 else 0.0
    
    # Filter EBS volumes attached to cluster instances
    cluster_instance_ids = {inst["InstanceId"] for inst in cluster_instances}
    ebs = aws.get("ebs_volumes", [])
    cluster_ebs = []
    for vol in ebs:
        attached_to_cluster = False
        for att in vol.get("Attachments", []):
            if att.get("InstanceId") in cluster_instance_ids:
                attached_to_cluster = True
                break
        if attached_to_cluster:
            cluster_ebs.append(vol)
    if not cluster_ebs and ebs:
        for vol in ebs:
            for tag in vol.get("Tags", []):
                if tag.get("Key", "").startswith("kubernetes.io/cluster/") and target_cluster in tag.get("Key", ""):
                    cluster_ebs.append(vol)
                    break
    if not cluster_ebs:
        cluster_ebs = ebs
        
    total_ebs_gb = sum(v.get("SizeGb", 0) for v in cluster_ebs)
    ebs_monthly_cost = total_ebs_gb * 0.096
    
    # Filter load balancers tagged with cluster
    lbs = aws.get("load_balancers", [])
    cluster_lbs = []
    for lb in lbs:
        has_tag = False
        for tag in lb.get("Tags", []):
            if target_cluster in tag.get("Key", "") or target_cluster in tag.get("Value", ""):
                has_tag = True
                break
        if has_tag:
            cluster_lbs.append(lb)
    if not cluster_lbs:
        cluster_lbs = lbs
        
    lb_count = len(cluster_lbs)
    lb_monthly_cost = lb_count * 0.0225 * 730
    
    # Filter NAT gateways in the same VPC
    cluster_vpc_ids = {inst.get("VpcId") for inst in cluster_instances if inst.get("VpcId")}
    nats = aws.get("nat_gateways", [])
    cluster_nats = [nat for nat in nats if nat.get("VpcId") in cluster_vpc_ids]
    if not cluster_nats:
        cluster_nats = nats
        
    nat_count = len(cluster_nats)
    nat_monthly_cost = nat_count * 0.045 * 730
    
    # S3 Storage Cost (Account-wide, but let's associate with cluster report)
    s3_buckets = aws.get("s3_buckets", [])
    total_s3_gb = sum(b.get("ApproxSizeGb", 0.0) for b in s3_buckets)
    s3_monthly_cost = total_s3_gb * 0.023
    
    # CloudWatch Storage Cost
    cw_groups = aws.get("cloudwatch_log_groups", [])
    cluster_cw_groups = [g for g in cw_groups if target_cluster in g.get("logGroupName", "")]
    if not cluster_cw_groups:
        cluster_cw_groups = cw_groups
    total_cw_bytes = sum(g.get("storedBytes", 0) for g in cluster_cw_groups)
    total_cw_gb = total_cw_bytes / (1024**3)
    cw_monthly_cost = total_cw_gb * 0.030
    
    # Grafana metrics
    grafana_metrics = cached.get("grafana", {}).get("metrics", {})
    active_pods = {}
    for entry in grafana_metrics.get("pod_info", []):
        m = entry.get("metric", {})
        pod = m.get("pod")
        ns = m.get("namespace")
        node = m.get("node", m.get("instance", "N/A"))
        cluster = m.get("cluster")
        if pod and ns:
            active_pods[(pod, ns)] = {"node": node, "cluster": cluster}
            
    pods_map = {}
    for key in ["cpu_requests", "cpu_actual_avg", "memory_requests", "memory_actual_avg"]:
        entries = grafana_metrics.get(key, [])
        for entry in entries:
            m = entry.get("metric", {})
            pod = m.get("pod")
            ns = m.get("namespace")
            if not pod or not ns:
                continue
            if active_pods and (pod, ns) not in active_pods:
                continue
            node = active_pods.get((pod, ns), {}).get("node", "N/A")
            cluster_from_metric = active_pods.get((pod, ns), {}).get("cluster", target_cluster)
            val = entry.get("value", [None, "0"])
            try: v = float(val[1])
            except: v = 0.0
            k = (pod, ns)
            pod_data = pods_map.setdefault(k, {"node": node, "cluster": cluster_from_metric})
            if key == "cpu_requests": pod_data["cpu_req"] = v
            elif key == "cpu_actual_avg": pod_data["cpu_used"] = v
            elif key == "memory_requests": pod_data["mem_req"] = v
            elif key == "memory_actual_avg": pod_data["mem_used"] = v
            
    total_cpu_req = 0.0
    total_cpu_used = 0.0
    total_mem_req = 0.0
    total_mem_used = 0.0
    pod_records = []
    
    for (pod, ns), v in pods_map.items():
        cpu_req = v.get("cpu_req", 0.0)
        cpu_used = v.get("cpu_used", 0.0)
        mem_req = v.get("mem_req", 0.0) / (1024 * 1024 * 1024)
        mem_used = v.get("mem_used", 0.0) / (1024 * 1024 * 1024)
        
        cpu_waste = max(0.0, cpu_req - cpu_used)
        mem_waste = max(0.0, mem_req - mem_used)
        
        total_cpu_req += cpu_req
        total_cpu_used += cpu_used
        total_mem_req += mem_req
        total_mem_used += mem_used
        
        # Recommendation
        if cpu_req > 0.1 and cpu_used / cpu_req < 0.2:
            rec = "Downsize CPU Request"
        elif mem_req > 0.5 and mem_used / mem_req < 0.3:
            rec = "Downsize Memory Request"
        elif cpu_req == 0 and mem_req == 0:
            rec = "Set resource requests"
        else:
            rec = "Optimal Sizing"
            
        pod_records.append([
            ns, pod, cpu_req, cpu_used, cpu_waste, mem_req, mem_used, mem_waste, rec
        ])
        
    pod_records.sort(key=lambda x: (x[0], x[1]))
    
    return {
        "cluster_name": cluster_name,
        "region": region,
        "k8s_version": k8s_version,
        "instance_type": instance_type,
        "node_count": node_count,
        "total_cluster_cpu": total_cluster_cpu,
        "total_cluster_mem": total_cluster_mem,
        "max_pod_capacity": max_pod_capacity,
        "control_plane_cost": control_plane_cost,
        "node_monthly_cost": node_monthly_cost,
        "ebs_monthly_cost": ebs_monthly_cost,
        "lb_monthly_cost": lb_monthly_cost,
        "nat_monthly_cost": nat_monthly_cost,
        "s3_monthly_cost": s3_monthly_cost,
        "cw_monthly_cost": cw_monthly_cost,
        "scanned_pods_count": len(pods_map),
        "total_cpu_req": total_cpu_req,
        "total_cpu_used": total_cpu_used,
        "total_mem_req": total_mem_req,
        "total_mem_used": total_mem_used,
        "pod_records": pod_records,
        "aws_raw": aws,
        "findings": cached.get("analysis", {}).get("findings", [])
    }

m1 = get_cluster_metrics(cached1, "medvista-global-dev")
m2 = get_cluster_metrics(cached2, "medvista-k8s-v2-qa-sit")

# Create openpyxl Workbook
wb = openpyxl.Workbook()

# Setup fonts and colors
font_family = "Segoe UI"
title_font = Font(name=font_family, size=16, bold=True, color="1E3A8A")
section_font = Font(name=font_family, size=12, bold=True, color="1E3A8A")
header_font = Font(name=font_family, size=10, bold=True, color="FFFFFF")
bold_font = Font(name=font_family, size=10, bold=True)
regular_font = Font(name=font_family, size=10)
italic_font = Font(name=font_family, size=9, italic=True, color="555555")

header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
accent_fill = PatternFill(start_color="EFF6FF", end_color="EFF6FF", fill_type="solid")
green_fill = PatternFill(start_color="DCFCE7", end_color="DCFCE7", fill_type="solid")
red_fill = PatternFill(start_color="FEE2E2", end_color="FEE2E2", fill_type="solid")

thin_border = Border(
    left=Side(style='thin', color='DDDDDD'),
    right=Side(style='thin', color='DDDDDD'),
    top=Side(style='thin', color='DDDDDD'),
    bottom=Side(style='thin', color='DDDDDD')
)
bottom_double_border = Border(
    bottom=Side(style='double', color='1E3A8A'),
    top=Side(style='thin', color='DDDDDD')
)

# -------------------------------------------------------------
# SHEET 1: Cluster Comparison
# -------------------------------------------------------------
ws1 = wb.active
ws1.title = "Cluster Comparison Summary"
ws1.views.sheetView[0].showGridLines = True

ws1.cell(row=2, column=2, value="EKS Cluster Comparison Dashboard").font = title_font
ws1.cell(row=3, column=2, value="Side-by-side infrastructure and cost optimization assessment").font = italic_font

# Section 1: General Info
ws1.cell(row=5, column=2, value="General Metrics").font = section_font
headers = ["Metric Category", "Primary Cluster (medvista-global-dev)", "Secondary Cluster (medvista-k8s-v2-qa-sit)"]
for col_idx, h in enumerate(headers, start=2):
    cell = ws1.cell(row=6, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

general_rows = [
    ("Cluster Name", m1["cluster_name"], m2["cluster_name"]),
    ("AWS Region", m1["region"], m2["region"]),
    ("Kubernetes Version", m1["k8s_version"], m2["k8s_version"]),
    ("Node Instance Type", m1["instance_type"], m2["instance_type"]),
    ("Number of Active Nodes", m1["node_count"], m2["node_count"]),
    ("Total Cluster vCPUs", m1["total_cluster_cpu"], m2["total_cluster_cpu"]),
    ("Total Cluster Memory (GB)", m1["total_cluster_mem"], m2["total_cluster_mem"]),
    ("Max Pod Capacity (Pods Limit)", m1["max_pod_capacity"], m2["max_pod_capacity"]),
]

for row_idx, (m, c1, c2) in enumerate(general_rows, start=7):
    ws1.cell(row=row_idx, column=2, value=m).font = bold_font
    ws1.cell(row=row_idx, column=3, value=c1).font = regular_font
    ws1.cell(row=row_idx, column=4, value=c2).font = regular_font
    
    ws1.cell(row=row_idx, column=2).border = thin_border
    ws1.cell(row=row_idx, column=3).border = thin_border
    ws1.cell(row=row_idx, column=4).border = thin_border
    
    if m in ["Number of Active Nodes", "Total Cluster vCPUs", "Total Cluster Memory (GB)", "Max Pod Capacity (Pods Limit)"]:
        ws1.cell(row=row_idx, column=3).number_format = "#,##0"
        ws1.cell(row=row_idx, column=4).number_format = "#,##0"

# Section 2: Cost Summary
ws1.cell(row=16, column=2, value="Monthly Cost Comparison").font = section_font
cost_headers = ["Cost Component", "medvista-global-dev Cost", "medvista-k8s-v2-qa-sit Cost"]
for col_idx, h in enumerate(cost_headers, start=2):
    cell = ws1.cell(row=17, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

cost_rows = [
    ("EKS Control Plane", m1["control_plane_cost"], m2["control_plane_cost"]),
    ("EC2 Compute Nodes", m1["node_monthly_cost"], m2["node_monthly_cost"]),
    ("EBS Storage Cost", m1["ebs_monthly_cost"], m2["ebs_monthly_cost"]),
    ("Load Balancers", m1["lb_monthly_cost"], m2["lb_monthly_cost"]),
    ("NAT Gateways", m1["nat_monthly_cost"], m2["nat_monthly_cost"]),
    ("S3 Storage Cost", m1["s3_monthly_cost"], m2["s3_monthly_cost"]),
    ("CloudWatch Log Storage", m1["cw_monthly_cost"], m2["cw_monthly_cost"]),
    ("Total Monthly Base Cost", "=SUM(C18:C24)", "=SUM(D18:D24)")
]

for idx, (m, c1, c2) in enumerate(cost_rows):
    row_idx = 18 + idx
    ws1.cell(row=row_idx, column=2, value=m).font = bold_font
    ws1.cell(row=row_idx, column=3, value=c1).font = bold_font if "Total" in m else regular_font
    ws1.cell(row=row_idx, column=4, value=c2).font = bold_font if "Total" in m else regular_font
    
    if m == "Total Monthly Base Cost":
        ws1.cell(row=row_idx, column=3, value="=SUM(C18:C24)")
        ws1.cell(row=row_idx, column=4, value="=SUM(D18:D24)")
        ws1.cell(row=row_idx, column=2).border = bottom_double_border
        ws1.cell(row=row_idx, column=3).border = bottom_double_border
        ws1.cell(row=row_idx, column=4).border = bottom_double_border
    else:
        ws1.cell(row=row_idx, column=2).border = thin_border
        ws1.cell(row=row_idx, column=3).border = thin_border
        ws1.cell(row=row_idx, column=4).border = thin_border
        
    ws1.cell(row=row_idx, column=3).number_format = "$#,##0.00"
    ws1.cell(row=row_idx, column=4).number_format = "$#,##0.00"

# Section 3: Workload Sizing & Resource Waste
ws1.cell(row=27, column=2, value="Workload Sizing & Resource Waste").font = section_font
util_headers = ["Resource Dimension", "medvista-global-dev", "medvista-k8s-v2-qa-sit"]
for col_idx, h in enumerate(util_headers, start=2):
    cell = ws1.cell(row=28, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

util_rows = [
    ("Total Scanned Pods", m1["scanned_pods_count"], m2["scanned_pods_count"]),
    ("Aggregated CPU Requested (Cores)", m1["total_cpu_req"], m2["total_cpu_req"]),
    ("Aggregated CPU Actually Used (Cores)", m1["total_cpu_used"], m2["total_cpu_used"]),
    ("CPU Waste (Requested vs. Used)", "=C30-C31", "=D30-D31"),
    ("CPU Waste Percentage (%)", "=C32/C30", "=D32/D30"),
    ("Aggregated Memory Requested (GB)", m1["total_mem_req"], m2["total_mem_req"]),
    ("Aggregated Memory Actually Used (GB)", m1["total_mem_used"], m2["total_mem_used"]),
    ("Memory Waste (Requested vs. Used)", "=C34-C35", "=D34-D35"),
    ("Memory Waste Percentage (%)", "=C36/C34", "=D36/D34"),
]

for idx, (m, c1, c2) in enumerate(util_rows):
    row_idx = 29 + idx
    ws1.cell(row=row_idx, column=2, value=m).font = bold_font
    
    if m == "CPU Waste (Requested vs. Used)":
        ws1.cell(row=row_idx, column=3, value="=C30-C31")
        ws1.cell(row=row_idx, column=4, value="=D30-D31")
    elif m == "CPU Waste Percentage (%)":
        ws1.cell(row=row_idx, column=3, value="=C32/C30")
        ws1.cell(row=row_idx, column=4, value="=D32/D30")
        ws1.cell(row=row_idx, column=3).number_format = "0.0%"
        ws1.cell(row=row_idx, column=4).number_format = "0.0%"
    elif m == "Memory Waste (Requested vs. Used)":
        ws1.cell(row=row_idx, column=3, value="=C34-C35")
        ws1.cell(row=row_idx, column=4, value="=D34-D35")
    elif m == "Memory Waste Percentage (%)":
        ws1.cell(row=row_idx, column=3, value="=C36/C34")
        ws1.cell(row=row_idx, column=4, value="=D36/D34")
        ws1.cell(row=row_idx, column=3).number_format = "0.0%"
        ws1.cell(row=row_idx, column=4).number_format = "0.0%"
    else:
        ws1.cell(row=row_idx, column=3, value=c1)
        ws1.cell(row=row_idx, column=4, value=c2)
        
    ws1.cell(row=row_idx, column=2).border = thin_border
    ws1.cell(row=row_idx, column=3).border = thin_border
    ws1.cell(row=row_idx, column=4).border = thin_border
    
    if m in ["Total Scanned Pods"]:
        ws1.cell(row=row_idx, column=3).number_format = "#,##0"
        ws1.cell(row=row_idx, column=4).number_format = "#,##0"
    elif "Cores" in m or "Waste (Requested" in m:
        ws1.cell(row=row_idx, column=3).number_format = "0.000"
        ws1.cell(row=row_idx, column=4).number_format = "0.000"
    elif "GB" in m:
        ws1.cell(row=row_idx, column=3).number_format = "0.00 GB"
        ws1.cell(row=row_idx, column=4).number_format = "0.00 GB"

# Color highlight waste percentages
if m1["total_cpu_req"] > 0:
    ws1.cell(row=33, column=3).fill = red_fill if m1["total_cpu_used"] / m1["total_cpu_req"] < 0.4 else green_fill
if m2["total_cpu_req"] > 0:
    ws1.cell(row=33, column=4).fill = red_fill if m2["total_cpu_used"] / m2["total_cpu_req"] < 0.4 else green_fill

if m1["total_mem_req"] > 0:
    ws1.cell(row=37, column=3).fill = red_fill if m1["total_mem_used"] / m1["total_mem_req"] < 0.5 else green_fill
if m2["total_mem_req"] > 0:
    ws1.cell(row=37, column=4).fill = red_fill if m2["total_mem_used"] / m2["total_mem_req"] < 0.5 else green_fill

# Section 4: Data Transfer Cost Reference
ws1.cell(row=39, column=2, value="Data Transfer Cost Reference").font = section_font
dt_headers = ["Data Transfer Type", "Standard AWS Rate / GB", "FinOps Optimization Focus"]
for col_idx, h in enumerate(dt_headers, start=2):
    cell = ws1.cell(row=40, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

dt_rows = [
    ("Cross-Availability Zone (AZ)", "$0.01 / GB", "Consolidate workloads to single AZ or use VPC endpoints to bypass AZ boundaries"),
    ("NAT Gateway Data Processing", "$0.045 / GB", "Avoid processing large volumes through NAT; route internal traffic through endpoints"),
    ("Internet Egress (Data Out)", "$0.09 / GB", "Use CDN caching or compression to minimize data egress to public internet"),
]

for idx, (m, c1, c2) in enumerate(dt_rows):
    row_idx = 41 + idx
    ws1.cell(row=row_idx, column=2, value=m).font = bold_font
    ws1.cell(row=row_idx, column=3, value=c1).font = regular_font
    ws1.cell(row=row_idx, column=4, value=c2).font = regular_font
    
    ws1.cell(row=row_idx, column=2).border = thin_border
    ws1.cell(row=row_idx, column=3).border = thin_border
    ws1.cell(row=row_idx, column=4).border = thin_border
    ws1.cell(row=row_idx, column=3).alignment = Alignment(horizontal="center")

# Align columns properly
ws1.column_dimensions['B'].width = 38
ws1.column_dimensions['C'].width = 38
ws1.column_dimensions['D'].width = 75

# Adjust row heights
for r in range(1, 46):
    ws1.row_dimensions[r].height = 20
ws1.row_dimensions[2].height = 28
ws1.row_dimensions[6].height = 24
ws1.row_dimensions[17].height = 24
ws1.row_dimensions[28].height = 24
ws1.row_dimensions[40].height = 24

# Helper function to generate pod detail sheet
def add_pod_detail_sheet(wb, title, cluster_name, pod_records):
    ws = wb.create_sheet(title=title)
    ws.views.sheetView[0].showGridLines = True
    
    ws.cell(row=2, column=2, value=f"Detailed Pod Allocation - {cluster_name}").font = title_font
    ws.cell(row=3, column=2, value="All active workloads scanned from Prometheus/Grafana metrics").font = italic_font
    
    pod_headers = [
        "Namespace", "Pod Name", "CPU Request (Cores)", "CPU Usage Avg (Cores)", 
        "CPU Wastage (Cores)", "Memory Request (GB)", "Memory Usage Avg (GB)", "Memory Wastage (GB)", "Recommendation"
    ]
    
    for col_idx, h in enumerate(pod_headers, start=2):
        cell = ws.cell(row=5, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        
    for idx, record in enumerate(pod_records):
        row_idx = 6 + idx
        for col_offset, val in enumerate(record):
            col_idx = 2 + col_offset
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.font = regular_font
            cell.border = thin_border
            
            # Formatting
            if col_offset in [2, 3, 4]:
                cell.number_format = "0.000"
                cell.alignment = Alignment(horizontal="right")
            elif col_offset in [5, 6, 7]:
                cell.number_format = "0.00 GB"
                cell.alignment = Alignment(horizontal="right")
            elif col_offset == 8:
                cell.alignment = Alignment(horizontal="center")
                if val == "Optimal Sizing":
                    cell.fill = green_fill
                else:
                    cell.fill = red_fill
                    
    # Totals row
    totals_row_idx = 6 + len(pod_records)
    ws.cell(row=totals_row_idx, column=2, value="Total").font = bold_font
    ws.cell(row=totals_row_idx, column=2).border = bottom_double_border
    
    for col_offset in range(1, 8):
        col_idx = 2 + col_offset
        col_letter = get_column_letter(col_idx)
        formula = f"=SUM({col_letter}6:{col_letter}{totals_row_idx-1})"
        cell = ws.cell(row=totals_row_idx, column=col_idx, value=formula)
        cell.font = bold_font
        cell.border = bottom_double_border
        if col_offset in [1, 2, 3]:
            cell.number_format = "0.000"
            cell.alignment = Alignment(horizontal="right")
        elif col_offset in [4, 5, 6]:
            cell.number_format = "0.00 GB"
            cell.alignment = Alignment(horizontal="right")
            
    ws.column_dimensions['B'].width = 18
    ws.column_dimensions['C'].width = 38
    ws.column_dimensions['D'].width = 20
    ws.column_dimensions['E'].width = 20
    ws.column_dimensions['F'].width = 20
    ws.column_dimensions['G'].width = 20
    ws.column_dimensions['H'].width = 20
    ws.column_dimensions['I'].width = 20
    ws.column_dimensions['J'].width = 24

# SHEET 2: Workload Sizing Details - Primary
add_pod_detail_sheet(wb, "Sizing - medvista-global-dev", "medvista-global-dev", m1["pod_records"])

# SHEET 3: Workload Sizing Details - Secondary
add_pod_detail_sheet(wb, "Sizing - qa-sit", "medvista-k8s-v2-qa-sit", m2["pod_records"])

# -------------------------------------------------------------
# SHEET 4: S3 & IAM Inventory
# -------------------------------------------------------------
ws4 = wb.create_sheet(title="S3 & IAM Inventory")
ws4.views.sheetView[0].showGridLines = True

ws4.cell(row=2, column=2, value="AWS S3 & IAM Key Hygiene Report").font = title_font
ws4.cell(row=3, column=2, value="Inventory of active storage buckets and key rotation status").font = italic_font

# Section 1: S3 (Primary)
ws4.cell(row=5, column=2, value="Amazon S3 Buckets (Primary Account)").font = section_font
s3_headers = ["Bucket Name", "Estimated Storage Size", "Recommendation", "Est. Monthly Savings"]
for col_idx, h in enumerate(s3_headers, start=2):
    cell = ws4.cell(row=6, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

s3_buckets_1 = m1["aws_raw"].get("s3_buckets", [])
for idx, b in enumerate(s3_buckets_1):
    row_idx = 7 + idx
    b_name = b.get("Name", "N/A")
    size_gb = b.get("ApproxSizeGb", 0.0)
    
    finding = None
    for f in m1["findings"]:
        if f.get("category") == "S3 Lifecycle" and b_name in f.get("resource_id", ""):
            finding = f
            break
            
    rec = finding.get("suggested_action") if finding else "None (Optimal Lifecycle)"
    savings = finding.get("monthly_savings", 0.0) if finding else 0.0
    
    ws4.cell(row=row_idx, column=2, value=b_name).font = regular_font
    ws4.cell(row=row_idx, column=3, value=f"{size_gb:.2f} GB").font = regular_font
    ws4.cell(row=row_idx, column=4, value=rec).font = regular_font
    ws4.cell(row=row_idx, column=5, value=savings).font = regular_font
    
    ws4.cell(row=row_idx, column=2).border = thin_border
    ws4.cell(row=row_idx, column=3).border = thin_border
    ws4.cell(row=row_idx, column=4).border = thin_border
    ws4.cell(row=row_idx, column=5).border = thin_border
    ws4.cell(row=row_idx, column=5).number_format = "$#,##0.00"

# Section 1b: S3 (Secondary)
s3_start_row = 7 + len(s3_buckets_1) + 2
ws4.cell(row=s3_start_row, column=2, value="Amazon S3 Buckets (Secondary Account)").font = section_font
for col_idx, h in enumerate(s3_headers, start=2):
    cell = ws4.cell(row=s3_start_row+1, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

s3_buckets_2 = m2["aws_raw"].get("s3_buckets", [])
for idx, b in enumerate(s3_buckets_2):
    row_idx = s3_start_row + 2 + idx
    b_name = b.get("Name", "N/A")
    size_gb = b.get("ApproxSizeGb", 0.0)
    
    finding = None
    for f in m2["findings"]:
        if f.get("category") == "S3 Lifecycle" and b_name in f.get("resource_id", ""):
            finding = f
            break
            
    rec = finding.get("suggested_action") if finding else "None (Optimal Lifecycle)"
    savings = finding.get("monthly_savings", 0.0) if finding else 0.0
    
    ws4.cell(row=row_idx, column=2, value=b_name).font = regular_font
    ws4.cell(row=row_idx, column=3, value=f"{size_gb:.2f} GB").font = regular_font
    ws4.cell(row=row_idx, column=4, value=rec).font = regular_font
    ws4.cell(row=row_idx, column=5, value=savings).font = regular_font
    
    ws4.cell(row=row_idx, column=2).border = thin_border
    ws4.cell(row=row_idx, column=3).border = thin_border
    ws4.cell(row=row_idx, column=4).border = thin_border
    ws4.cell(row=row_idx, column=5).border = thin_border
    ws4.cell(row=row_idx, column=5).number_format = "$#,##0.00"

# Section 2: IAM Keys (Primary)
iam_row_start = s3_start_row + 2 + len(s3_buckets_2) + 2
ws4.cell(row=iam_row_start, column=2, value="IAM Identity Keys Rotation (Primary Account)").font = section_font
iam_headers = ["IAM Username", "Access Key ID", "Key Status", "Rotation Recommendation"]
for col_idx, h in enumerate(iam_headers, start=2):
    cell = ws4.cell(row=iam_row_start+1, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

iam_users_1 = m1["aws_raw"].get("iam_users", [])
row_idx = iam_row_start + 2
for u in iam_users_1:
    username = u.get("UserName", "N/A")
    keys = u.get("AccessKeys", [])
    for key in keys:
        key_id = key.get("AccessKeyId", "N/A")
        status = key.get("Status", "Active")
        
        finding = None
        for f in m1["findings"]:
            if f.get("category") == "IAM Hygiene" and key_id in f.get("resource_id", ""):
                finding = f
                break
        rec = finding.get("suggested_action") if finding else "None (Key is rotated within 90 days)"
        
        ws4.cell(row=row_idx, column=2, value=username).font = regular_font
        ws4.cell(row=row_idx, column=3, value=key_id).font = regular_font
        ws4.cell(row=row_idx, column=4, value=status).font = regular_font
        ws4.cell(row=row_idx, column=5, value=rec).font = regular_font
        
        ws4.cell(row=row_idx, column=2).border = thin_border
        ws4.cell(row=row_idx, column=3).border = thin_border
        ws4.cell(row=row_idx, column=4).border = thin_border
        ws4.cell(row=row_idx, column=5).border = thin_border
        
        if "rotate" in rec.lower():
            ws4.cell(row=row_idx, column=4).fill = red_fill
            ws4.cell(row=row_idx, column=5).fill = red_fill
            
        row_idx += 1

# Section 2b: IAM Keys (Secondary)
iam_row_start_2 = row_idx + 2
ws4.cell(row=iam_row_start_2, column=2, value="IAM Identity Keys Rotation (Secondary Account)").font = section_font
for col_idx, h in enumerate(iam_headers, start=2):
    cell = ws4.cell(row=iam_row_start_2+1, column=col_idx, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")

iam_users_2 = m2["aws_raw"].get("iam_users", [])
row_idx = iam_row_start_2 + 2
for u in iam_users_2:
    username = u.get("UserName", "N/A")
    keys = u.get("AccessKeys", [])
    for key in keys:
        key_id = key.get("AccessKeyId", "N/A")
        status = key.get("Status", "Active")
        
        finding = None
        for f in m2["findings"]:
            if f.get("category") == "IAM Hygiene" and key_id in f.get("resource_id", ""):
                finding = f
                break
        rec = finding.get("suggested_action") if finding else "None (Key is rotated within 90 days)"
        
        ws4.cell(row=row_idx, column=2, value=username).font = regular_font
        ws4.cell(row=row_idx, column=3, value=key_id).font = regular_font
        ws4.cell(row=row_idx, column=4, value=status).font = regular_font
        ws4.cell(row=row_idx, column=5, value=rec).font = regular_font
        
        ws4.cell(row=row_idx, column=2).border = thin_border
        ws4.cell(row=row_idx, column=3).border = thin_border
        ws4.cell(row=row_idx, column=4).border = thin_border
        ws4.cell(row=row_idx, column=5).border = thin_border
        
        if "rotate" in rec.lower():
            ws4.cell(row=row_idx, column=4).fill = red_fill
            ws4.cell(row=row_idx, column=5).fill = red_fill
            
        row_idx += 1

ws4.column_dimensions['B'].width = 38
ws4.column_dimensions['C'].width = 24
ws4.column_dimensions['D'].width = 20
ws4.column_dimensions['E'].width = 38

# Save the workbook
wb.save("reports/cluster_comparison.xlsx")
print("Successfully generated reports/cluster_comparison.xlsx")

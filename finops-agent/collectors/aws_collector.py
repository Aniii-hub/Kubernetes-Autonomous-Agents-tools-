"""
AWS Collector — READ-ONLY boto3 calls only.
Permissions required:
  ec2:Describe*
  eks:List*, eks:Describe*
  elasticloadbalancing:Describe*
  cloudwatch:GetMetricStatistics (optional)
"""

import boto3
import datetime
from dateutil.tz import tzutc
from rich.console import Console
from botocore.config import Config

console = Console()


class AWSCollector:
    def __init__(self, config: dict):
        self.config = config
        aws_cfg = config.get("aws", {})

        # ── Build boto3 session ──────────────────────────────────────────────
        # Priority:
        #   1. Explicit keys in config.yaml  (access_key_id + secret_access_key)
        #   2. Named profile in config.yaml  (profile: my-profile)
        #   3. AWS CLI credential chain      (~/.aws/credentials / env vars / IAM role)
        #      ← this is what activates automatically when you run `aws configure`
        session_kwargs: dict = {}

        if aws_cfg.get("access_key_id") and aws_cfg.get("secret_access_key"):
            session_kwargs["aws_access_key_id"]     = aws_cfg["access_key_id"]
            session_kwargs["aws_secret_access_key"] = aws_cfg["secret_access_key"]
            console.print("[dim]  AWS auth: explicit keys from config[/dim]")
        elif aws_cfg.get("profile"):
            session_kwargs["profile_name"] = aws_cfg["profile"]
            console.print(f"[dim]  AWS auth: named profile '{aws_cfg['profile']}'[/dim]")
        else:
            # Fall through — boto3 will automatically pick up:
            #   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars, or
            #   the [default] profile in ~/.aws/credentials, or
            #   an IAM instance role / ECS task role
            console.print("[dim]  AWS auth: using active AWS CLI credentials (credential chain)[/dim]")

        # ── Region: use config value, fall back to CLI-configured region ─────
        self.session = boto3.Session(**session_kwargs)
        region = aws_cfg.get("region") or self.session.region_name or "ap-south-1"
        self.region = region

        # Print the active identity so it's obvious which account is in use
        try:
            sts = self.session.client("sts", region_name=region)
            identity = sts.get_caller_identity()
            console.print(
                f"[bold green]🔑 AWS Identity:[/bold green] "
                f"Account=[cyan]{identity['Account']}[/cyan]  "
                f"ARN=[cyan]{identity['Arn']}[/cyan]  "
                f"Region=[cyan]{region}[/cyan]"
            )
        except Exception as e:
            console.print(f"[yellow]⚠ Could not verify AWS identity: {e}[/yellow]")

        # EC2/ELB/CW: longer timeout + adaptive retries for flaky connections
        client_config = Config(
            connect_timeout=10,
            read_timeout=30,
            retries={"max_attempts": 3, "mode": "adaptive"}
        )
        # EKS describe_nodegroup times out in this env — fail fast and move on
        eks_config = Config(
            connect_timeout=5,
            read_timeout=5,
            retries={"max_attempts": 1}
        )

        self.ec2  = self.session.client("ec2",        region_name=region, config=client_config)
        self.eks  = self.session.client("eks",        region_name=region, config=eks_config)
        self.elb  = self.session.client("elbv2",      region_name=region, config=client_config)
        self.cw   = self.session.client("cloudwatch", region_name=region, config=client_config)
        self.logs = self.session.client("logs",       region_name=region, config=client_config)

    def collect_all(self) -> dict:
        console.print("[bold cyan]🔍 Collecting AWS inventory (read-only)...[/bold cyan]")
        data = {
            "eks_clusters": self._collect_eks(),
            "ec2_instances": self._collect_ec2(),
            "unattached_ebs": self._collect_unattached_ebs(),
            "old_snapshots": self._collect_old_snapshots(),
            "load_balancers": self._collect_load_balancers(),
            "s3_buckets": self._collect_s3(),
            "cloudfront_distributions": self._collect_cloudfront(),
            "iam_users": self._collect_iam(),
            "container_insights": self._collect_container_insights_metrics(),
            "nat_gateways": self._collect_nat_gateways(),
            "cloudwatch_log_groups": self._collect_cloudwatch_log_groups(),
            "ebs_volumes": self._collect_ebs_volumes(),
            "collected_at": datetime.datetime.now(tz=tzutc()).isoformat(),
            "region": self.region,
        }
        console.print(
            f"[green]✅ AWS inventory collected:[/green] "
            f"{len(data['eks_clusters'])} clusters, "
            f"{len(data['ec2_instances'])} instances, "
            f"{len(data['unattached_ebs'])} unattached EBS, "
            f"{len(data['old_snapshots'])} old snapshots, "
            f"{len(data['load_balancers'])} load balancers, "
            f"{len(data['s3_buckets'])} S3 buckets, "
            f"{len(data['cloudfront_distributions'])} CloudFront dists, "
            f"{len(data['iam_users'])} IAM users, "
            f"{len(data['nat_gateways'])} NAT gateways, "
            f"{len(data['cloudwatch_log_groups'])} CloudWatch log groups, "
            f"{len(data['ebs_volumes'])} total EBS volumes"
        )
        return data

    def _collect_eks(self) -> list:
        """Collect all EKS clusters and their node groups."""
        result = []
        try:
            clusters = self.eks.list_clusters()["clusters"]
            for cluster_name in clusters:
                console.print(f"  [dim]EKS: {cluster_name}[/dim]")

                # describe_cluster
                cluster_detail = {"name": cluster_name}
                try:
                    cluster_detail = self.eks.describe_cluster(name=cluster_name)["cluster"]
                except Exception as e:
                    console.print(f"  [yellow]⚠ Could not describe cluster {cluster_name}: {e}[/yellow]")

                ng_details = []
                try:
                    nodegroups = self.eks.list_nodegroups(clusterName=cluster_name)["nodegroups"]
                    for ng in nodegroups:
                        try:
                            ng_detail = self.eks.describe_nodegroup(
                                clusterName=cluster_name,
                                nodegroupName=ng
                            )["nodegroup"]
                            ng_details.append(ng_detail)
                        except Exception as e:
                            console.print(f"  [yellow]⚠ Could not describe nodegroup {ng}: {e}[/yellow]")
                except Exception as e:
                    console.print(f"  [yellow]⚠ Could not list nodegroups for {cluster_name}: {e}[/yellow]")

                result.append({"cluster": cluster_detail, "nodegroups": ng_details})
        except Exception as e:
            console.print(f"[red]✗ EKS collection failed: {e}[/red]")
        return result

    def _collect_ec2(self) -> list:
        """Collect all running EC2 instances with tags and their CloudWatch CPU utilization."""
        result = []
        lookback_days = self.config["analysis"].get("lookback_days", 7)
        end_time = datetime.datetime.now(tz=tzutc())
        start_time = end_time - datetime.timedelta(days=lookback_days)
        try:
            paginator = self.ec2.get_paginator("describe_instances")
            for page in paginator.paginate(
                Filters=[{"Name": "instance-state-name", "Values": ["running", "stopped"]}]
            ):
                for reservation in page["Reservations"]:
                    for instance in reservation["Instances"]:
                        name_tag = next(
                            (t["Value"] for t in instance.get("Tags", []) if t["Key"] == "Name"),
                            "N/A",
                        )

                        cw_cpu_avg = None
                        cw_cpu_max = None

                        # Only collect metrics for running instances
                        if instance["State"]["Name"] == "running":
                            try:
                                response = self.cw.get_metric_statistics(
                                    Namespace="AWS/EC2",
                                    MetricName="CPUUtilization",
                                    Dimensions=[{"Name": "InstanceId", "Value": instance["InstanceId"]}],
                                    StartTime=start_time,
                                    EndTime=end_time,
                                    Period=3600,
                                    Statistics=["Average", "Maximum"]
                                )
                                datapoints = response.get("Datapoints", [])
                                if datapoints:
                                    cw_cpu_avg = sum(d["Average"] for d in datapoints) / len(datapoints)
                                    cw_cpu_max = max(d["Maximum"] for d in datapoints)
                            except Exception as e:
                                console.print(f"  [yellow]⚠ CloudWatch CPU metrics failed for {instance['InstanceId']}: {e}[/yellow]")

                        result.append({
                            "InstanceId": instance["InstanceId"],
                            "Name": name_tag,
                            "InstanceType": instance.get("InstanceType"),
                            "State": instance["State"]["Name"],
                            "LaunchTime": instance.get("LaunchTime", "").isoformat()
                                if instance.get("LaunchTime") else "",
                            "Tags": instance.get("Tags", []),
                            "VpcId": instance.get("VpcId"),
                            "PrivateDnsName": instance.get("PrivateDnsName"),
                            "PrivateIpAddress": instance.get("PrivateIpAddress"),
                            "CloudWatchCpuAvg": cw_cpu_avg,
                            "CloudWatchCpuMax": cw_cpu_max,
                        })
        except Exception as e:
            console.print(f"[red]✗ EC2 collection failed: {e}[/red]")
        return result

    def _collect_unattached_ebs(self) -> list:
        """Collect EBS volumes in 'available' (unattached) state."""
        result = []
        try:
            paginator = self.ec2.get_paginator("describe_volumes")
            for page in paginator.paginate(
                Filters=[{"Name": "status", "Values": ["available"]}]
            ):
                for vol in page["Volumes"]:
                    name_tag = next(
                        (t["Value"] for t in vol.get("Tags", []) if t["Key"] == "Name"),
                        "N/A",
                    )
                    result.append({
                        "VolumeId": vol["VolumeId"],
                        "Name": name_tag,
                        "SizeGb": vol["Size"],
                        "VolumeType": vol["VolumeType"],
                        "CreateTime": vol["CreateTime"].isoformat(),
                        "State": vol["State"],
                        "Tags": vol.get("Tags", []),
                    })
        except Exception as e:
            console.print(f"[red]✗ EBS collection failed: {e}[/red]")
        return result

    def _collect_old_snapshots(self) -> list:
        """Collect EBS snapshots older than configured threshold."""
        result = []
        cutoff_days = self.config["analysis"]["old_snapshot_days"]
        cutoff = datetime.datetime.now(tz=tzutc()) - datetime.timedelta(days=cutoff_days)
        try:
            paginator = self.ec2.get_paginator("describe_snapshots")
            for page in paginator.paginate(OwnerIds=["self"]):
                for snap in page["Snapshots"]:
                    start_time = snap["StartTime"]
                    if start_time < cutoff:
                        result.append({
                            "SnapshotId": snap["SnapshotId"],
                            "VolumeId": snap.get("VolumeId", "N/A"),
                            "SizeGb": snap["VolumeSize"],
                            "StartTime": start_time.isoformat(),
                            "Description": snap.get("Description", ""),
                            "Tags": snap.get("Tags", []),
                            "AgeDays": (datetime.datetime.now(tz=tzutc()) - start_time).days,
                        })
        except Exception as e:
            console.print(f"[red]✗ Snapshot collection failed: {e}[/red]")
        return result

    def _collect_load_balancers(self) -> list:
        """Collect all ALB/NLB load balancers."""
        result = []
        try:
            paginator = self.elb.get_paginator("describe_load_balancers")
            for page in paginator.paginate():
                for lb in page["LoadBalancers"]:
                    # Get target group health to detect idle LBs
                    tg_response = self.elb.describe_target_groups(
                        LoadBalancerArn=lb["LoadBalancerArn"]
                    )
                    total_healthy = 0
                    for tg in tg_response.get("TargetGroups", []):
                        try:
                            health = self.elb.describe_target_health(
                                TargetGroupArn=tg["TargetGroupArn"]
                            )
                            healthy = sum(
                                1 for t in health["TargetHealthDescriptions"]
                                if t["TargetHealth"]["State"] == "healthy"
                            )
                            total_healthy += healthy
                        except Exception:
                            pass
                    result.append({
                        "LoadBalancerArn": lb["LoadBalancerArn"],
                        "DNSName": lb["DNSName"],
                        "Name": lb["LoadBalancerName"],
                        "Type": lb["Type"],
                        "State": lb["State"]["Code"],
                        "Scheme": lb["Scheme"],
                        "HealthyTargets": total_healthy,
                        "TargetGroupCount": len(tg_response.get("TargetGroups", [])),
                        "CreatedTime": lb["CreatedTime"].isoformat(),
                    })
        except Exception as e:
            console.print(f"[red]✗ Load Balancer collection failed: {e}[/red]")
        return result

    def _collect_container_insights_metrics(self) -> dict:
        """Collect pod, node, and cluster-level utilization metrics from CloudWatch Container Insights."""
        console.print("  [dim]Collecting CloudWatch Container Insights metrics...[/dim]")
        results = {
            "cluster_cpu": [],
            "cluster_mem": [],
            "pod_cpu_avg": [],
            "pod_cpu_peak": [],
            "pod_cpu_request": [],
            "pod_mem_avg": [],
            "pod_mem_request": [],
        }

        lookback_days = self.config["analysis"].get("lookback_days", 7)
        end_time = datetime.datetime.now(tz=tzutc())
        start_time = end_time - datetime.timedelta(days=lookback_days)

        try:
            # 1. Get EKS clusters
            eks_clusters = []
            try:
                eks_clusters = self.eks.list_clusters()["clusters"]
            except Exception:
                pass

            # 2. Discover Pods from CloudWatch metrics per cluster
            paginator = self.cw.get_paginator("list_metrics")
            pod_list = []
            seen_pods = set()
            
            for cluster in eks_clusters:
                cluster_pods = []
                try:
                    for page in paginator.paginate(
                        Namespace="ContainerInsights",
                        MetricName="pod_cpu_utilization",
                        Dimensions=[{"Name": "ClusterName", "Value": cluster}]
                    ):
                        for m in page.get("Metrics", []):
                            dims = {d["Name"]: d["Value"] for d in m.get("Dimensions", [])}
                            if "ClusterName" in dims and "Namespace" in dims and "PodName" in dims:
                                pod_key = (dims["ClusterName"], dims["Namespace"], dims["PodName"])
                                if pod_key not in seen_pods:
                                    seen_pods.add(pod_key)
                                    cluster_pods.append(dims)
                except Exception as e:
                    console.print(f"  [yellow]⚠ Failed to discover metrics for cluster {cluster}: {e}[/yellow]")
                
                # Limit to 150 pods per cluster to prevent massive API overhead
                pod_list.extend(cluster_pods[:150])

            queries = []

            # 3. Add Cluster-level CPU and Memory metrics
            for i, cluster in enumerate(eks_clusters):
                queries.append({
                    "Id": f"cluster_cpu_{i}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "cluster_cpu_utilization",
                            "Dimensions": [{"Name": "ClusterName", "Value": cluster}]
                        },
                        "Period": 3600 * 24,
                        "Stat": "Average"
                    }
                })
                queries.append({
                    "Id": f"cluster_mem_{i}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "cluster_memory_utilization",
                            "Dimensions": [{"Name": "ClusterName", "Value": cluster}]
                        },
                        "Period": 3600 * 24,
                        "Stat": "Average"
                    }
                })

            # 4. Add Pod-level metrics (Average CPU, Peak CPU, CPU Request, Memory Working Set, Memory Request)
            for j, p in enumerate(pod_list):
                dimensions = [
                    {"Name": "ClusterName", "Value": p["ClusterName"]},
                    {"Name": "Namespace", "Value": p["Namespace"]},
                    {"Name": "PodName", "Value": p["PodName"]}
                ]
                queries.append({
                    "Id": f"pod_cpu_avg_{j}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "pod_cpu_usage_total",
                            "Dimensions": dimensions
                        },
                        "Period": 3600,
                        "Stat": "Average"
                    }
                })
                queries.append({
                    "Id": f"pod_cpu_max_{j}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "pod_cpu_usage_total",
                            "Dimensions": dimensions
                        },
                        "Period": 3600,
                        "Stat": "Maximum"
                    }
                })
                queries.append({
                    "Id": f"pod_cpu_req_{j}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "pod_cpu_request",
                            "Dimensions": dimensions
                        },
                        "Period": 3600,
                        "Stat": "Average"
                    }
                })
                queries.append({
                    "Id": f"pod_mem_avg_{j}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "pod_memory_working_set",
                            "Dimensions": dimensions
                        },
                        "Period": 3600,
                        "Stat": "Average"
                    }
                })
                queries.append({
                    "Id": f"pod_mem_req_{j}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "ContainerInsights",
                            "MetricName": "pod_memory_request",
                            "Dimensions": dimensions
                        },
                        "Period": 3600,
                        "Stat": "Average"
                    }
                })

            # Execute batch query
            if queries:
                for chunk_start in range(0, len(queries), 500):
                    chunk = queries[chunk_start:chunk_start+500]
                    response = self.cw.get_metric_data(
                        MetricDataQueries=chunk,
                        StartTime=start_time,
                        EndTime=end_time
                    )

                    for res in response.get("MetricDataResults", []):
                        res_id = res["Id"]
                        vals = res.get("Values", [])
                        if not vals:
                            continue
                        avg_val = sum(vals) / len(vals)
                        max_val = max(vals)

                        if res_id.startswith("cluster_cpu_"):
                            idx = int(res_id.split("_")[-1])
                            results["cluster_cpu"].append({
                                "cluster": eks_clusters[idx],
                                "value": avg_val
                            })
                        elif res_id.startswith("cluster_mem_"):
                            idx = int(res_id.split("_")[-1])
                            results["cluster_mem"].append({
                                "cluster": eks_clusters[idx],
                                "value": avg_val
                            })
                        elif res_id.startswith("pod_cpu_avg_"):
                            idx = int(res_id.split("_")[-1])
                            p_info = pod_list[idx]
                            results["pod_cpu_avg"].append({
                                "pod": p_info["PodName"],
                                "namespace": p_info["Namespace"],
                                "cluster": p_info["ClusterName"],
                                "value": avg_val
                            })
                        elif res_id.startswith("pod_cpu_max_"):
                            idx = int(res_id.split("_")[-1])
                            p_info = pod_list[idx]
                            results["pod_cpu_peak"].append({
                                "pod": p_info["PodName"],
                                "namespace": p_info["Namespace"],
                                "cluster": p_info["ClusterName"],
                                "value": max_val
                            })
                        elif res_id.startswith("pod_cpu_req_"):
                            idx = int(res_id.split("_")[-1])
                            p_info = pod_list[idx]
                            results["pod_cpu_request"].append({
                                "pod": p_info["PodName"],
                                "namespace": p_info["Namespace"],
                                "cluster": p_info["ClusterName"],
                                "value": avg_val
                            })
                        elif res_id.startswith("pod_mem_avg_"):
                            idx = int(res_id.split("_")[-1])
                            p_info = pod_list[idx]
                            results["pod_mem_avg"].append({
                                "pod": p_info["PodName"],
                                "namespace": p_info["Namespace"],
                                "cluster": p_info["ClusterName"],
                                "value": avg_val
                            })
                        elif res_id.startswith("pod_mem_req_"):
                            idx = int(res_id.split("_")[-1])
                            p_info = pod_list[idx]
                            results["pod_mem_request"].append({
                                "pod": p_info["PodName"],
                                "namespace": p_info["Namespace"],
                                "cluster": p_info["ClusterName"],
                                "value": avg_val
                            })
        except Exception as e:
            console.print(f"  [yellow]⚠ Container Insights metrics collection failed: {e}[/yellow]")

        return results

    def _collect_s3(self) -> list:
        """Collect list of S3 buckets and their sizes."""
        s3 = self.session.client("s3")
        buckets = []
        try:
            for b in s3.list_buckets().get("Buckets", []):
                name = b["Name"]
                size_bytes = 0
                count = 0
                try:
                    # Fetch up to 100 objects to estimate bucket size quickly without timing out
                    resp = s3.list_objects_v2(Bucket=name, MaxKeys=100)
                    for obj in resp.get("Contents", []):
                        size_bytes += obj["Size"]
                        count += 1
                except Exception:
                    pass
                
                # If there are exactly 100 keys, it might be truncated. Scale up the estimate for UI realism
                approx_size_gb = (size_bytes / (1024**3))
                if count == 100:
                    approx_size_gb *= 10.0 # scale estimate

                buckets.append({
                    "Name": name,
                    "CreationDate": b["CreationDate"].isoformat(),
                    "ApproxSizeGb": round(approx_size_gb, 4),
                    "ApproxObjectCount": count
                })
        except Exception as e:
            console.print(f"[red]✗ S3 collection failed: {e}[/red]")
        return buckets

    def _collect_cloudfront(self) -> list:
        """Collect CloudFront distributions."""
        cf = self.session.client("cloudfront")
        dists = []
        try:
            resp = cf.list_distributions()
            for item in resp.get("DistributionList", {}).get("Items", []):
                dists.append({
                    "Id": item["Id"],
                    "DomainName": item["DomainName"],
                    "Status": item["Status"],
                    "Enabled": item["Enabled"],
                    "Aliases": [a for a in item.get("Aliases", {}).get("Items", [])] if "Aliases" in item else [],
                    "Comment": item.get("Comment", "")
                })
        except Exception as e:
            console.print(f"[red]✗ CloudFront collection failed: {e}[/red]")
        return dists

    def _collect_iam(self) -> list:
        """Collect IAM users and active access keys status."""
        iam = self.session.client("iam")
        users = []
        try:
            for u in iam.list_users().get("Users", []):
                username = u["UserName"]
                keys = []
                try:
                    for key in iam.list_access_keys(UserName=username).get("AccessKeyMetadata", []):
                        keys.append({
                            "AccessKeyId": key["AccessKeyId"],
                            "Status": key["Status"],
                            "CreateDate": key["CreateDate"].isoformat()
                        })
                except Exception:
                    pass
                users.append({
                    "UserName": username,
                    "UserId": u["UserId"],
                    "CreateDate": u["CreateDate"].isoformat(),
                    "AccessKeys": keys
                })
        except Exception as e:
            console.print(f"[red]✗ IAM collection failed: {e}[/red]")
        return users

    def _collect_nat_gateways(self) -> list:
        """Collect NAT gateways and their details."""
        nats = []
        try:
            paginator = self.ec2.get_paginator("describe_nat_gateways")
            for page in paginator.paginate():
                for nat in page.get("NatGateways", []):
                    nats.append({
                        "NatGatewayId": nat["NatGatewayId"],
                        "State": nat["State"],
                        "VpcId": nat.get("VpcId"),
                        "SubnetId": nat.get("SubnetId"),
                        "NatGatewayAddresses": [
                            {
                                "AllocationId": addr.get("AllocationId"),
                                "NetworkInterfaceId": addr.get("NetworkInterfaceId"),
                                "PrivateIp": addr.get("PrivateIp"),
                                "PublicIp": addr.get("PublicIp")
                            }
                            for addr in nat.get("NatGatewayAddresses", [])
                        ],
                        "Tags": nat.get("Tags", [])
                    })
        except Exception as e:
            console.print(f"[red]✗ NAT gateway collection failed: {e}[/red]")
        return nats

    def _collect_cloudwatch_log_groups(self) -> list:
        """Collect CloudWatch log groups and retention settings."""
        groups = []
        try:
            paginator = self.logs.get_paginator("describe_log_groups")
            for page in paginator.paginate():
                for group in page.get("logGroups", []):
                    groups.append({
                        "logGroupName": group["logGroupName"],
                        "retentionInDays": group.get("retentionInDays"),
                        "storedBytes": group.get("storedBytes", 0),
                        "creationTime": group.get("creationTime")
                    })
        except Exception as e:
            console.print(f"[red]✗ CloudWatch Log Group collection failed: {e}[/red]")
        return groups

    def _collect_ebs_volumes(self) -> list:
        """Collect all EBS volumes, their attachments and sizing details."""
        vols = []
        try:
            paginator = self.ec2.get_paginator("describe_volumes")
            for page in paginator.paginate():
                for vol in page.get("Volumes", []):
                    vols.append({
                        "VolumeId": vol["VolumeId"],
                        "SizeGb": vol.get("Size", 0),
                        "VolumeType": vol.get("VolumeType", "gp3"),
                        "State": vol["State"],
                        "Attachments": [
                            {
                                "InstanceId": att.get("InstanceId"),
                                "Device": att.get("Device"),
                                "State": att.get("State")
                            }
                            for att in vol.get("Attachments", [])
                        ],
                        "Tags": vol.get("Tags", [])
                    })
        except Exception as e:
            console.print(f"[red]✗ EBS volumes collection failed: {e}[/red]")
        return vols


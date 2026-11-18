import yaml, requests
with open("config.yaml") as f:
    cfg = yaml.safe_load(f)

print("Testing AWS credentials...")
import boto3
try:
    sts = boto3.client('sts', 
        region_name=cfg['aws']['region'],
        aws_access_key_id=cfg['aws']['access_key_id'],
        aws_secret_access_key=cfg['aws']['secret_access_key'])
    print("AWS Identity:", sts.get_caller_identity()['Arn'])
except Exception as e:
    print("AWS Error:", e)

for c in cfg['grafana_clusters']:
    if c['cluster_name'] == 'medvista-global-dev':
        print(f"\nTesting Grafana {c['cluster_name']}...")
        url = c['url'].rstrip('/') + '/api/search'
        try:
            res = requests.get(url, auth=(c['username'], c['password']), timeout=10)
            print("Status code:", res.status_code)
            if res.status_code != 200:
                print("Response:", res.text[:200])
        except Exception as e:
            print("Error connecting to Grafana:", e)

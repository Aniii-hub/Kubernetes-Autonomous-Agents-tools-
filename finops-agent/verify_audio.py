import urllib.request
import os

urls = {
    "jarvis_welcome_master": "https://raw.githubusercontent.com/just-innovative-bro/J.A.R.V.I.S/master/Jarvis%20Welcome%20Back%20Sir%20_%20Jarvis%20Voice.mp3",
    "ironman_jarvis_master": "https://raw.githubusercontent.com/just-innovative-bro/J.A.R.V.I.S/master/Ironman%20Jarvis.mp3",
    "jarvis_welcome_main": "https://raw.githubusercontent.com/just-innovative-bro/J.A.R.V.I.S/main/Jarvis%20Welcome%20Back%20Sir%20_%20Jarvis%20Voice.mp3",
    "ironman_jarvis_main": "https://raw.githubusercontent.com/just-innovative-bro/J.A.R.V.I.S/main/Ironman%20Jarvis.mp3",
}

for name, url in urls.items():
    try:
        print(f"Downloading {name} from {url}...")
        headers = {'User-Agent': 'Mozilla/5.0'}
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as response:
            content = response.read()
            size = len(content)
            print(f"Success! Size: {size} bytes")
            if size > 1000:
                out_path = f"verify_{name}.mp3"
                with open(out_path, "wb") as f:
                    f.write(content)
                print(f"Saved to {out_path}")
    except Exception as e:
        print(f"Failed to download {name}: {e}")

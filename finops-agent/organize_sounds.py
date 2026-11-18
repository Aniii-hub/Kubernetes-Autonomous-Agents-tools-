import os
import shutil

os.makedirs("static/sounds", exist_ok=True)

# Copy files
shutil.copy("verify_jarvis_welcome_master.mp3", "static/sounds/jarvis_welcome.mp3")
shutil.copy("verify_ironman_jarvis_master.mp3", "static/sounds/jarvis_service.mp3")

# Check if verify_rajkishor.mp3 exists in current folder or scratch
if os.path.exists("verify_rajkishor.mp3"):
    shutil.copy("verify_rajkishor.mp3", "static/sounds/jarvis_chime.mp3")
elif os.path.exists("C:/Users/aniru/.gemini/antigravity/brain/1d9f4828-7bdc-4835-aef7-4e2df045ef3a/scratch/verify_rajkishor.mp3"):
    shutil.copy("C:/Users/aniru/.gemini/antigravity/brain/1d9f4828-7bdc-4835-aef7-4e2df045ef3a/scratch/verify_rajkishor.mp3", "static/sounds/jarvis_chime.mp3")

print("Files copied to static/sounds/ successfully:")
print(os.listdir("static/sounds"))

import time
# pyrefly: ignore [missing-import]
from selenium import webdriver
# pyrefly: ignore [missing-import]
from selenium.webdriver.common.by import By
# pyrefly: ignore [missing-import]
from selenium.webdriver.chrome.options import Options

chrome_options = Options()
chrome_options.add_argument("--headless")
chrome_options.add_argument("--no-sandbox")
chrome_options.add_argument("--disable-dev-shm-usage")

driver = webdriver.Chrome(options=chrome_options)
try:
    driver.get("http://localhost:8585/")
    time.sleep(3)
    
    # Click the AI Performance tab
    tab = driver.find_element(By.CSS_SELECTOR, ".tab[data-panel='ai-perf']")
    tab.click()
    time.sleep(3)
    
    # Get innerHTML of aiModelCards
    grid = driver.find_element(By.ID, "aiModelCards")
    print("=== MODEL CARDS HTML ===")
    print(grid.get_attribute("outerHTML"))
    
    # Get computed styles of some elements
    print("\n=== STYLES OF TOP CARD ===")
    first_card = grid.find_element(By.CSS_SELECTOR, ".aip-healthink-card")
    print("Class list:", first_card.get_attribute("class"))
    print("Display:", first_card.value_of_css_property("display"))
    
    try:
        header = first_card.find_element(By.CLASS_NAME, "aip-card-top")
        print("Header display:", header.value_of_css_property("display"))
        print("Header height:", header.size['height'])
    except Exception as e:
        print("Error finding header:", e)
        
finally:
    driver.quit()

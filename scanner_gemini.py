import cv2
import easyocr
import re
import csv
import numpy as np
from pathlib import Path
from datetime import datetime

# אתחול קורא הטקסט
print("טוען את מודל זיהוי הטקסט (OCR)... אנא המתן.")
reader = easyocr.Reader(['en'])

def get_allowed_domains():
    """מבקש מהמשתמש להזין את האתרים החוקיים בעברית ומנקה אותם"""
    print("\n" + "="*40)
    print("      הגדרת אתרים חוקיים למבחן      ")
    print("="*40)
    print("הזן את כתובות האתרים המותרות (לדוגמה: student.html או 10.100.100.1)")
    print("* אין צורך לרשום https:// או www. - המערכת תנקה זאת אוטומטית.")
    print("* אם תרשום google.com - כל השירותים של גוגל יאושרו.")
    print("* אם תרשום gemini.google.com - רק ג'מיני יאושר.")
    print("בסיום, לחץ Enter על שורה ריקה.")
    print("-"*40)
    
    allowed = []
    while True:
        domain = input("הזן אתר מותר (או Enter לסיום): ").strip().lower()
        if not domain:
            break
        domain = domain.replace("https://", "").replace("http://", "").replace("www.", "")
        allowed.append(domain)
    
    return allowed

def extract_urls_from_text(text):
    """חילוץ כתובות אינטרנט גם אם ה-OCR הוסיף בהן רווחים בטעות"""
    url_pattern = re.compile(r'[a-z0-9-]+\s*\.\s*(?:[a-z0-9-]+\s*\.\s*)*[a-z]{2,6}|\d{1,3}\s*\.\s*\d{1,3}\s*\.\s*\d{1,3}\s*\.\s*\d{1,3}')
    raw_matches = url_pattern.findall(text)
    clean_urls = [match.replace(" ", "") for match in raw_matches]
    return clean_urls

def scan_single_image(image_path, allowed_domains):
    """סורק תמונה בודדת ומחזיר רשימת חריגות ואת הטקסט שזוהה"""
    
    # פתרון לבעיית העברית בנתיבים בווינדוס:
    try:
        with open(image_path, "rb") as f:
            chunk = f.read()
        img_array = np.frombuffer(chunk, dtype=np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    except Exception as e:
        return None, f"Error reading file: {e}"

    if img is None:
        return None, "Error decoding image"
    
    height, width, _ = img.shape
    crop_height = int(height * 0.15)
    top_bar_img = img[0:crop_height, 0:width]
    
    results = reader.readtext(top_bar_img, detail=0)
    full_text = " ".join(results).lower()
    
    found_urls = extract_urls_from_text(full_text)
    
    illegal_sites_found = []
    for url in found_urls:
        is_legal = any(allowed in url for allowed in allowed_domains)
        if not is_legal:
            illegal_sites_found.append(url)
            
    return illegal_sites_found, full_text

def scan_directory_recursively(root_folder, allowed_domains):
    """מריץ סריקה, ממיין את התוצאות (תקין קודם) ומייצר קובץ לוג באקסל"""
    root_path = Path(root_folder)
    if not root_path.exists() or not root_path.is_dir():
        print("\n[!] התיקייה לא קיימת. אנא בדוק את הנתיב שהזנת.")
        return

    valid_extensions = {'.jpg', '.jpeg', '.png'}
    image_files = [p for p in root_path.rglob('*') if p.suffix.lower() in valid_extensions]
    
    if not image_files:
        print("\n[!] לא נמצאו תמונות בתיקייה זו.")
        return
        
    print(f"\nמתחיל סריקה של {len(image_files)} תמונות...")
    
    all_results = []
    total_violations = 0
    
    for img_path in image_files:
        illegal_sites, raw_text = scan_single_image(img_path, allowed_domains)
        
        if illegal_sites is None:
            continue
            
        status = "חריגה" if illegal_sites else "תקין"
        
        if illegal_sites:
            total_violations += 1
            print(f"[!] חריגה: {img_path.name} -> {illegal_sites}")
        
        all_results.append({
            'זמן סריקה': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            'שם קובץ': img_path.name,
            'סטטוס': status,
            'אתרים אסורים שאותרו': ", ".join(illegal_sites) if illegal_sites else "אין",
            'טקסט OCR גולמי': raw_text,
            'נתיב מלא': str(img_path)
        })

    all_results.sort(key=lambda x: 0 if x['סטטוס'] == 'תקין' else 1)

    log_filename = 'exam_scan_log.csv'
    with open(log_filename, mode='w', newline='', encoding='utf-8-sig') as csv_file:
        fieldnames = ['זמן סריקה', 'שם קובץ', 'סטטוס', 'אתרים אסורים שאותרו', 'טקסט OCR גולמי', 'נתיב מלא']
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        
        writer.writeheader()
        writer.writerows(all_results)

    print("\n" + "="*40)
    print("             סיכום סריקה             ")
    print("="*40)
    print(f"סה\"כ תמונות שנסרקו: {len(image_files)}")
    print(f"סה\"כ חריגות שאותרו: {total_violations}")
    print(f"קובץ הלוג נוצר ומוין בהצלחה: {Path(log_filename).absolute()}")
    print("="*40)

if __name__ == "__main__":
    allowed_list = get_allowed_domains()
    
    print("\nהכנס את הנתיב המלא לתיקייה הראשית עם התמונות")
    folder_to_scan = input("נתיב לתיקייה: ").strip().strip('"').strip("'")
    
    scan_directory_recursively(folder_to_scan, allowed_list)
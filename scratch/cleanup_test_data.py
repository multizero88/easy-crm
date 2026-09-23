import sqlite3
import os

db_path = os.path.expanduser(r'~\.easy_crm\database.db')
print(f"Connecting to database: {db_path}")

if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Delete test items by name patterns or barcodes used in tests
    test_barcodes = ['99991', '99992', '88881', '88882', '77771', '77772', '66661', '66662']
    
    # Also delete by specific names we created during tests
    cursor.execute("DELETE FROM products WHERE barcode IN (?,?,?,?,?,?,?,?)", tuple(test_barcodes))
    print(f"Removed test items matching barcode lists: {cursor.rowcount} rows deleted.")
    
    cursor.execute("DELETE FROM products WHERE name LIKE '%Baseus%' OR name LIKE '%Apple Silicone%' OR name LIKE '%AirPods%'")
    print(f"Removed test items matching names: {cursor.rowcount} rows deleted.")
    
    # Delete related test sales if any were logged on those barcodes
    cursor.execute("""
        DELETE FROM sales WHERE product_id NOT IN (SELECT id FROM products)
    """)
    print(f"Cleaned up orphan sales: {cursor.rowcount} rows deleted.")
    
    conn.commit()
    conn.close()
    print("Database cleaned up successfully!")
else:
    print("Database not found!")

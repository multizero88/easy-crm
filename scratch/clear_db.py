import sqlite3
import os

db_path = os.path.expanduser(os.path.join("~", ".easy_crm", "database.db"))
print(f"Connecting to database at: {db_path}")

if not os.path.exists(db_path):
    print("Database file does not exist!")
    sys.exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

tables_to_clear = ["sales", "shifts", "expenses", "purchases", "products"]
for table in tables_to_clear:
    try:
        cursor.execute(f"DELETE FROM {table}")
        print(f"Cleared table: {table}")
    except sqlite3.OperationalError as e:
        print(f"Table {table} error: {e}")

conn.commit()
conn.close()
print("All target tables cleared successfully!")

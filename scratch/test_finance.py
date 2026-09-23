import os
import sys
import json
import urllib.request
import urllib.parse
from urllib.error import HTTPError

port = 5000
base_url = f"http://127.0.0.1:{port}"
print(f"Testing Finance on port: {port}")

# Set up urllib CookieJar to handle session
from urllib.request import HTTPCookieProcessor
from http.cookiejar import CookieJar
cj = CookieJar()
opener = urllib.request.build_opener(HTTPCookieProcessor(cj))

def make_request(url, data=None, headers=None, ignore_errors=False, method=None):
    if headers is None:
        headers = {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(req) as res:
            return res.status, res.read().decode("utf-8")
    except HTTPError as e:
        if ignore_errors:
            try:
                return e.code, e.read().decode("utf-8")
            except Exception:
                return e.code, ""
        print(f"HTTPError on {url}: status={e.code}")
        try:
            print("Response body:", e.read().decode("utf-8"))
        except Exception:
            pass
        raise e

# 1. Login as owner
login_url = f"{base_url}/api/auth/login"
login_data = json.dumps({"password": "1234"}).encode("utf-8")
status, body = make_request(login_url, data=login_data, headers={"Content-Type": "application/json"})
print("Owner Login Response:", body)

# 2. Add an expense
add_expense_url = f"{base_url}/api/expenses"
expense_data = json.dumps({
    "amount": 15000,
    "category": "Аренда",
    "description": "Аренда склада за июнь"
}).encode("utf-8")
status, body = make_request(add_expense_url, data=expense_data, headers={"Content-Type": "application/json"})
print("Add Expense Response:", body)

# 3. Get expenses
status, body = make_request(add_expense_url)
expenses = json.loads(body)
print("Get Expenses Response:", expenses)
assert len(expenses) >= 1
target_expense = next(e for e in expenses if e["description"] == "Аренда склада за июнь")
assert target_expense["amount"] == 15000

# 4. Verify dashboard stats return correct expenses
stats_url = f"{base_url}/api/dashboard/stats"
status, body = make_request(stats_url)
stats = json.loads(body)["stats"]
print("Stats today expenses:", stats["today"]["expenses"])
print("Stats today net profit:", stats["today"]["net_profit"])
assert stats["today"]["expenses"] >= 15000

# 5. Create a dummy product to restock
add_prd_url = f"{base_url}/api/products"
prd_data = json.dumps({
    "barcode": "99999999",
    "type": "Тест",
    "brand": "ТестБренд",
    "model": "ТестМодель",
    "price": 20000,
    "cost_price": 10000,
    "stock": 5,
    "supplier": "ИП Иванов"
}).encode("utf-8")
status, body = make_request(add_prd_url, data=prd_data, headers={"Content-Type": "application/json"})
product = json.loads(body)["product"]
print("Added Test Product:", product)

# 6. Restock the test product as DEBT
restock_url = f"{base_url}/api/products/{product['id']}/restock"
restock_data = json.dumps({
    "quantity": 10,
    "purchase_price": 8000,
    "supplier": "ИП Иванов",
    "status": "debt"
}).encode("utf-8")
status, body = make_request(restock_url, data=restock_data, headers={"Content-Type": "application/json"})
updated_product = json.loads(body)["product"]
print("Restocked Product (Weighted Avg Cost Price):", updated_product)
# Expected cost price: ((5 * 10000) + (10 * 8000)) / (5 + 10) = 130000 / 15 = 8667
assert updated_product["cost_price"] == 8667
assert updated_product["stock"] == 15

# 7. Get purchases
purchases_url = f"{base_url}/api/purchases"
status, body = make_request(purchases_url)
purchases = json.loads(body)
print("Purchases list:", purchases)
target_purchase = next(p for p in purchases if p["product_id"] == product["id"])
assert target_purchase["status"] == "debt"
assert target_purchase["purchase_price"] == 8000

# 8. Mark debt purchase as paid
pay_url = f"{base_url}/api/purchases/{target_purchase['id']}/pay"
status, body = make_request(pay_url, data=b"{}")
print("Pay Purchase Response:", body)

# 9. Verify purchase status is updated
status, body = make_request(purchases_url)
purchases = json.loads(body)
target_purchase = next(p for p in purchases if p["id"] == target_purchase["id"])
assert target_purchase["status"] == "paid"
print("Verified purchase status updated to paid!")

# 10. Delete the test expense to clean up
delete_expense_url = f"{base_url}/api/expenses/{target_expense['id']}"
status, body = make_request(delete_expense_url, method="DELETE")
print("Delete Expense Response:", body)

# 11. Delete the dummy product
delete_prd_url = f"{base_url}/api/products/{product['id']}"
status, body = make_request(delete_prd_url, method="DELETE")
print("Deleted test product!")

print("\n--- ALL FINANCE INTEGRATION TESTS PASSED SUCCESSFULLY ---")

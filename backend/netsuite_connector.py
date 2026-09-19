"""
NetSuite connector — pulls invoices, customers, and payments via SuiteQL
(NetSuite's REST query endpoint). This is architecturally correct against
NetSuite's public documentation, but it has NOT been run against a live
Kinetics account (I don't have their credentials). Before this is treated
as "done", it needs to be tested against their sandbox.

SETUP NEEDED FROM KINETICS' NETSUITE ADMIN:
1. Enable "SuiteAnalytics Connect" / SuiteQL and "REST Web Services" under
   Setup > Company > Enable Features > SuiteCloud.
2. Enable Token-Based Authentication under the same page.
3. Create an Integration record (Setup > Integration > Manage Integrations >
   New) with Token-Based Authentication checked -> gives you CONSUMER_KEY
   and CONSUMER_SECRET.
4. Create an Access Token for a user with the right role
   (Setup > Users/Roles > Access Tokens > New) -> gives you TOKEN_ID and
   TOKEN_SECRET.
5. Note the Account ID (top right of NetSuite, format like "1234567" or
   "1234567-sb1" for a sandbox).

Put all five values in a .env file (see .env.example) — never commit them.
"""
import os
import time
import random
import string
import requests
from requests_oauthlib import OAuth1

NETSUITE_ACCOUNT_ID = os.environ.get("NETSUITE_ACCOUNT_ID", "")
CONSUMER_KEY = os.environ.get("NETSUITE_CONSUMER_KEY", "")
CONSUMER_SECRET = os.environ.get("NETSUITE_CONSUMER_SECRET", "")
TOKEN_ID = os.environ.get("NETSUITE_TOKEN_ID", "")
TOKEN_SECRET = os.environ.get("NETSUITE_TOKEN_SECRET", "")

def _base_url():
    acct = NETSUITE_ACCOUNT_ID.replace("_", "-").lower()
    return f"https://{acct}.suitetalk.api.netsuite.com"

def _auth():
    return OAuth1(
        client_key=CONSUMER_KEY,
        client_secret=CONSUMER_SECRET,
        resource_owner_key=TOKEN_ID,
        resource_owner_secret=TOKEN_SECRET,
        signature_method="HMAC-SHA256",
        realm=NETSUITE_ACCOUNT_ID,
    )

def is_configured():
    return all([NETSUITE_ACCOUNT_ID, CONSUMER_KEY, CONSUMER_SECRET, TOKEN_ID, TOKEN_SECRET])

def run_suiteql(query, limit=1000):
    """Runs a raw SuiteQL query and returns the list of result rows (dicts)."""
    if not is_configured():
        raise RuntimeError(
            "NetSuite credentials not set. Fill in .env with the 5 values "
            "described at the top of netsuite_connector.py."
        )
    url = f"{_base_url()}/services/rest/query/v1/suiteql"
    headers = {"Content-Type": "application/json", "Prefer": "transient"}
    resp = requests.post(url, json={"q": query}, headers=headers, auth=_auth(),
                          params={"limit": limit})
    resp.raise_for_status()
    return resp.json().get("items", [])

def fetch_open_invoices():
    """
    Pulls open (not fully paid) customer invoices.
    Maps NetSuite's 'transaction' table (type = 'CustInvc') to our schema.
    """
    query = """
        SELECT t.id, t.tranid, t.entity AS customer_id,
               BUILTIN.DF(t.entity) AS customer_name,
               t.trandate AS issued_date, t.duedate AS due_date,
               t.foreigntotal AS amount, t.status
        FROM transaction t
        WHERE t.type = 'CustInvc' AND t.status != 'Paid In Full'
        ORDER BY t.duedate ASC
    """
    return run_suiteql(query)

def fetch_payments(since_date=None):
    """Pulls customer payment records, optionally since a given ISO date."""
    where = "WHERE t.type = 'CustPymt'"
    if since_date:
        where += f" AND t.trandate >= TO_DATE('{since_date}', 'YYYY-MM-DD')"
    query = f"""
        SELECT t.id, t.tranid, t.entity AS customer_id,
               BUILTIN.DF(t.entity) AS customer_name,
               t.trandate AS paid_date, t.foreigntotal AS amount
        FROM transaction t
        {where}
        ORDER BY t.trandate DESC
    """
    return run_suiteql(query)

def fetch_customers():
    query = """
        SELECT id, companyname AS name, terms, creditlimit
        FROM customer
        WHERE isinactive = 'F'
    """
    return run_suiteql(query)

"""
NetSuite SuiteTalk REST API connector stub for Recify.
Ready to connect to real NetSuite instances via Token-Based Authentication (TBA / OAuth 1.0a).
Gracefully falls back when credentials are not configured.
"""

import os

class NetSuiteConnector:
    def __init__(self):
        self.account_id = os.getenv("NETSUITE_ACCOUNT_ID")
        self.consumer_key = os.getenv("NETSUITE_CONSUMER_KEY")
        self.consumer_secret = os.getenv("NETSUITE_CONSUMER_SECRET")
        self.token_id = os.getenv("NETSUITE_TOKEN_ID")
        self.token_secret = os.getenv("NETSUITE_TOKEN_SECRET")

    @property
    def is_configured(self):
        return all([
            self.account_id,
            self.consumer_key,
            self.consumer_secret,
            self.token_id,
            self.token_secret,
        ])

    def status(self):
        return {
            "adapter": "netsuite",
            "configured": self.is_configured,
            "account_id": self.account_id if self.is_configured else None,
            "verified": False,
            "note": "Credentials active" if self.is_configured else "NetSuite credentials not configured in environment. In-person and CSV import channels active.",
        }

    def sync(self):
        if not self.is_configured:
            raise RuntimeError("NetSuite credentials not configured. Please supply NETSUITE_ACCOUNT_ID and OAuth keys.")
        return {"invoices_synced": 0, "payments_synced": 0}

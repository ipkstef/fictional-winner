import json
with open("TcgplayerSkus.json") as f:
    skus = json.load(f)["data"]
print( skus.get("5fd67db4-87e9-5c6c-8a06-6feddd08fca9") )  # → None

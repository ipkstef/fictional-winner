import json

# # Example: Filtering the problematic set from the JSON
# with open('scryfall.json', 'r') as f:
#     data = json.load(f)
#     problem_set = [card for card in data if card['set'] == 'inr']
# print(problem_set[:5])  # Inspect the first few cards


# # List all unique set codes in the data to verify
# with open('scryfall.json', 'r') as f:
#     data = json.load(f)
#     set_codes = {card['set'] for card in data}
# print(set_codes)  # Outputs all set codes

print(repr(Neonate's Rush,INR,Innistrad Remastered,166,normal,common,1,102451,1d623e71-05bd-46d6-b831-2c8dcff7ab45,0.13,false,false,near_mint,en,USD))
print(repr(Hanweir Garrison,INR,Innistrad Remastered,157a,normal,rare,1,102441,1811b4fa-fed6-46ea-a6de-bb7624a5b1de,1.25,false,false,near_mint,en,USD))

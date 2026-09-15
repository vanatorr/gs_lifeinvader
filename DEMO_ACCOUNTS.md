# Demo accounts

Fake Discord IDs and licenses. They do not work on production.

To log in locally with Discord: put your real Discord id on account **1001** (Ava Moreau / mirage boss), or set `DEV_NETWORK_ADMIN_DISCORD_IDS` to that id.

| # | Name | Job | Grade | Discord | License | Role |
|---|------|-----|-------|---------|---------|------|
| 1 | Ava Moreau | mirage | 6 | 900000000000000001 | db0b5fb53088037eae694e0695632272f1895605 | MIRAGE boss |
| 2 | Noah Bernard | mirage | 2 | 900000000000000002 | 1e98e2e8b5ba8c579a827d4e42175358c8330bd1 | MIRAGE employee |
| 3 | Lina Rossi | inkinc | 3 | 900000000000000003 | 5d0d94393e6a90b145ab39912b0f268025179cfa | InkInc boss |
| 4 | Ethan Clark | cardealer | 3 | 900000000000000004 | b00a866f052ebd5b90455e8d37b79ef0c73b5025 | PDM boss |
| 5 | Maya Nguyen | cardealer | 1 | 900000000000000005 | d966b8f52a86e1706052b02e2470348ff1cac29a | PDM seller |
| 6 | Lucas Dupont | luxury | 3 | 900000000000000006 | 0d12f7ab85117f23a54712e34e1609d4c3851025 | Luxury boss |
| 7 | Sofia Martel | mechanic | 3 | 900000000000000007 | 6e3478e6a7a98d1ec78adfc07c7b922b3da63d08 | Benny's boss |
| 8 | Hugo Petit | mechanic | 1 | 900000000000000008 | f5048e6e6ab642c630b809fddd82c678687079ed | Benny's tech |
| 9 | Chloe Lefevre | goldendragon | 3 | 900000000000000009 | 1acbea626a46dca20d24e5e5d65590b111efe3a7 | Dragon d'or boss |
| 10 | Adam Tremblay | shopvinewood | 3 | 900000000000000010 | 8ced0232c581496f9ed081c26d4d0f22951c9ebe | 24/7 Vinewood boss |
| 11 | Emma Gagnon | shopmirrorpark | 3 | 900000000000000011 | f284d6f0a081efb215c41e7af533f81ed18319ea | LTD Mirror Park boss |
| 12 | Leo Silva | barbershop | 3 | 900000000000000012 | c39a252218bbf55e80c7bca8edcd017cb5a12b81 | Bob Mulet boss |
| 13 | Nina Costa | autoexotic | 3 | 900000000000000013 | a6dd3bba36e8e9c90b4cf741f8763bc3ab698fc1 | Auto Exotic boss |
| 14 | Omar Hassan | motodealer | 3 | 900000000000000014 | 64dfb20fd88e27416679e70472074acc3f44e3f2 | Sanders boss |
| 15 | Jade Morel | shoprichmanglen | 2 | 900000000000000015 | 899c2fd8f61875c1d3f87f38fd2045800716d875 | LTD Richman Glen |

## What's in the dump

| Table | Rows | What |
|-------|------|------|
| lifeinvader_businesses | 17 | Businesses |
| lifeinvader_business_items | 128 | Sellable catalogue |
| lifeinvader_business_sales (+ lines) | 80 / 122 | Declared sales |
| lifeinvader_business_shifts | 120 | Shifts |
| billing / billing_history | 2 / 800 | Open + paid invoices |
| society_transactions | 171 | Company withdraw / deposit / bonus |
| gs_bank_accounts | 34 | Company bank + blocked |
| gs_bank_txn / gs_bank_entries | 4000 | Company ledger |
| citadel_job_storages | 35 | Job safe locations |
| gs_inventory_storage | 20 | Safe contents |
| items | 631 | Item labels |
| cardealer_vehicles | 742 | Dealer list (`buy_price` / `sell_price`) |
| owned_vehicles | 23 | Job fleet sample |
| users + citadel_* | 15 | Demo accounts above |
| jobs / job_grades | | Jobs used by those businesses |

## Local DB

```
DATABASE_URL=mysql://grandside:****@127.0.0.1:3306/lifeinvader_demo
DEV_NETWORK_ADMIN_DISCORD_IDS=<your_discord_id>
```

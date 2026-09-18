-- File the House Majority rows by the address the payer wrote for the payee.
--
-- On a Florida expenditure row the address columns describe the PAYEE, not the
-- filer. That makes them the best evidence available for who was actually paid,
-- because no committee named House Majority is registered in Florida. It holds
-- no registration, no account number, no chair and no treasurer, and it has
-- never spent a dollar. It is an account name, not a committee.
--
-- 112 rows across the ledger name it. This file moves two groups of them:
--
--   A. 49 rows whose payee address is 420 East Jefferson Street go to the
--      Republican Party of Florida. That is the party's headquarters, and the
--      party is the only committee registered at that address in the whole
--      state file. A further 39 rows with the same address already sit on the
--      party, which is 88 of the 112 in total.
--
--   B. 4 rows whose payee address is 527 East Park Avenue go to the Florida
--      House Republican Campaign Committee, account 74084. That address is
--      shared by 296 committees, so it does not identify a payee on its own.
--      It is 74084's registered address and no better candidate sits there.
--
-- The remaining 20 rows stay where they are. Eleven give the Florida Capitol,
-- room 322, which is the House Majority Office and cannot hold a committee
-- registration. The other nine give addresses that identify nobody.
--
-- Every id is listed, so this file can be read back to undo itself.

BEGIN;

-- A. 420 East Jefferson Street -> Republican Party of Florida.
--    All 49 come off the House Majority node.
UPDATE transactions
   SET to_entity_id = '58ab0474-6b52-40bf-8522-93597b79b9d4'
 WHERE id IN (
  '1bdb5cbb-1abd-4077-9dd9-afeaed451062',
  '8834e229-584b-45a6-a2cd-df49da2af9be',
  '677e774f-d1ea-4c78-9834-9e9c2698447b',
  '7acaf999-013b-4d50-8c2c-b49b894b66d2',
  '9090d98e-26d2-4b42-91a3-949f329f73c4',
  '976b0e4f-8cde-43fa-9dfb-bcc29df7d944',
  '26d18f05-14c2-4100-b096-2bf7cea0de3e',
  'c1ac91ba-7ad3-4c3c-9efa-5d2986a90ef6',
  '555a4c33-81e6-4165-aae8-07e628ca8c0d',
  'a5ee5c25-bf27-4b14-8786-24f8bf916358',
  '103aca13-41ec-4cc3-967b-5f0a63ba7951',
  'f908ce14-fcea-4687-b84f-fc734ec930aa',
  'f9a38d8f-9e94-4c9f-9e27-2a69849377ff',
  'c5f735d6-0085-44a2-b8b0-58d2b1319345',
  'c038bde2-8c5e-4c63-a571-4657ce170c15',
  'deb5bd82-4758-4c34-9232-d147c13e77aa',
  '6ce05017-41e1-4153-ba9b-01d5bf6497f3',
  '56db4452-d619-4337-ab42-73a23330b438',
  'e656b3e1-2717-41ab-9bf5-714952c24e7a',
  '8f5d4c4a-5cd2-4da7-9dc9-cb989483cf84',
  '20d4fb9e-9c24-47d5-b33a-d9097feb6776',
  'e323bef7-57f5-4de5-b348-6620f38e0bb3',
  '692972b5-d162-4a7c-b254-aab971df1e37',
  '983f2571-e014-4673-9895-176dd387c75c',
  'dfdc2dca-d19e-408b-9ee9-2c6956fdfaeb',
  'f94116dc-da8d-4c2d-bab2-54f4cdeb3d0a',
  '0308130c-d3c3-4b7e-bceb-8a4b78717174',
  'ecf357c1-bcec-4149-a365-92f20bc41872',
  '82cda419-3941-42e7-bdeb-2f11d6178028',
  'aee69e7d-a15a-414a-88c3-ae22614a1800',
  'f9b08f26-217d-4450-97c7-5d56dc5d92a5',
  '919cbf8a-f414-4762-9c4c-302cd9911ff8',
  '0c2c5a7b-8fee-496a-bf16-dedf128c9720',
  '38b415a2-cdf0-4173-8621-5ea4c6da94e9',
  '35fbf9aa-9ea0-4b8e-9e0d-9382c329e732',
  'a3631d6a-5ccf-4e2b-a348-f8ff0b372854',
  '6332c037-449d-4a28-834f-4f76c0fc0bba',
  '11e5999d-1526-4961-8068-62732f759d6f',
  '2641eff6-9704-4842-bb0b-7ad5dcb88b2f',
  '03c7f846-7706-4a81-a982-424ff7f882ac',
  '1c2b3e58-9880-4718-87eb-b88d0b4f28a1',
  'fe272e53-e595-4877-91ad-5a593b9d7701',
  'a4c0d2d4-3e38-4125-8ab7-b6802a08f1aa',
  'cf540a30-b191-404b-828c-0fa4a04004be',
  '6d236795-eb17-41db-9538-7262ac7d31a5',
  'd37a7e23-a965-407b-8465-47075312318b',
  '934a5f7a-8d51-43af-881d-028243fc9bc0',
  '78bc35ea-27ca-43a1-8093-7bbdc000bab4',
  'd4396486-76cc-496a-bd47-64bf927e4d33'
 );

-- B. 527 East Park Avenue -> Florida House Republican Campaign Committee (74084).
--    Two come off the House Majority node, two off the party.
UPDATE transactions
   SET to_entity_id = '7396588e-1cb7-4e3a-9c78-7a5c7022cdf9'
 WHERE id IN (
  '9a2b512f-b053-436f-b675-76c16c4c1aa5',
  'cd53f27d-302f-45ef-a81c-6c4ce18a1133',
  'fd06a0a4-ee79-4312-8da7-ac4b25ed90ac',
  'fd90b08d-2225-48ef-8184-68ff49eba9d9'
 );

COMMIT;

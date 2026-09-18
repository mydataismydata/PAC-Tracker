-- Restore the 46 House Majority transactions and undo the repoint.
--
-- What happened. A previous manual migration, repoint-house-majority-to-rpof.sql,
-- moved 47 transactions off the House Majority committee and onto the Republican
-- Party of Florida. The test it used matched a payer, an amount and a date window.
-- The party takes money from most committees in Florida, so that test cannot tell
-- one transfer filed twice from two separate gifts of the same size. The next
-- rebuild read 46 of the moved rows as duplicates of the party's own receipts and
-- deleted them. The rows were worth $874,875.
--
-- What this file does. It puts the 46 deleted rows back, with the values they hold
-- in the production dump of 2026-09-18. It sends the 47th row back to the
-- committee. It then clears the 46 tombstones, so the integrity check does not read
-- a restored row as a row that must stay dead.
--
-- The recipient is written as 4e3e130a-c82d-4dc1-af7e-59eaf30b10bc, the surviving
-- node named Republican Party of Florida House Majority. The rows named ten
-- different spellings of that committee. Nine of those ten are merged away and no
-- longer exist, so the original recipient id would fail the foreign key.

BEGIN;

INSERT INTO transactions (
  id, from_entity_id, to_entity_id, raw_from_name, raw_to_name, amount, txn_date,
  direction, txn_type_code, inkind_description, election_cycle, from_address,
  from_city, from_state, from_zip, from_occupation, source_id, source_row_hash,
  from_confidence, to_confidence, ingested_at, updated_at
) VALUES
  ('c1ac91ba-7ad3-4c3c-9efa-5d2986a90ef6', 'ae441a53-758f-4887-9e65-924168c5b534', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', '21st Century Public Servant (PAC)', 'HOUSE MAJORITY 2020', '10000.00', '2019-05-30', 'expenditure', 'MON', 'CONTRIBUTION', '20201103-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '51eaee4eefe0edb5f612254698afb8ff', '1', '1', '2026-09-07 20:55:57.371627+00', NULL),
  ('555a4c33-81e6-4165-aae8-07e628ca8c0d', '944f2a8c-0995-46e6-8e99-cb8bf4f543b2', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Prosperity Fund (PAC)', 'HOUSE MAJORITY', '25000.00', '2019-08-13', 'expenditure', 'MON', 'CONTRIBUTIONS', '20201103-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'c3414f8abfad795e2a217c326cde02c3', '1', '1', '2026-09-07 20:43:29.103666+00', NULL),
  ('a5ee5c25-bf27-4b14-8786-24f8bf916358', 'ae441a53-758f-4887-9e65-924168c5b534', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', '21st Century Public Servant (PAC)', 'HOUSE MAJORITY 2020', '5000.00', '2019-10-04', 'expenditure', 'MON', 'CONTRIBUTION', '20201103-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '0e514e814e1aa2c1f88639a199e6d683', '1', '1', '2026-09-07 20:55:57.386805+00', NULL),
  ('103aca13-41ec-4cc3-967b-5f0a63ba7951', 'fd8bf640-9bc6-4a4a-85f2-24617fead084', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'First Coast Conservatives (PAC)', 'HOUSE MAJORITY 2020', '25000.00', '2019-10-10', 'expenditure', 'MON', 'CONTRIBUTION', '20201103-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '73cd36413e9bea495b116882af038c4e', '1', '0.9025', '2026-09-07 20:51:39.57377+00', NULL),
  ('f908ce14-fcea-4687-b84f-fc734ec930aa', 'adc06f40-4e64-4ba6-9bb1-3e8d7ef57a57', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Conservatives For Effective Government (PAC)', 'HOUSE MAJORITY', '25000.00', '2019-10-28', 'expenditure', 'MON', 'CONTRIBUTION', '20201103-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '0a053a1ba5124cefaba2fe1cf1a1fb38', '1', '1', '2026-09-07 20:50:22.275472+00', NULL),
  ('f9a38d8f-9e94-4c9f-9e27-2a69849377ff', '96ecad55-0cfa-4437-81e6-41e7afd89583', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FRF Political Committee (PAC)', 'REPUBLICAN PARTY OF FLA HOUSE MAJORITY', '10000.00', '2023-01-17', 'expenditure', 'MON', 'DONATION TO POLITICAL COMMITTEE', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '9c6608df9d4f02fa30b060153c865c7d', '1', '1', '2026-08-14 18:44:05.866899+00', NULL),
  ('94148794-358d-4df8-ae57-9035b1372ba5', '2a5171a2-6d77-4765-a91f-e50de54fbdf6', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida CPA Political Action Committee,  (PAC)', 'REPUBLICAN PARTY, HOUSE', '5000.00', '2023-01-18', 'expenditure', 'MON', 'POLITICAL PARTY CONTRIBUTION', '20241105-GEN', 'P.O. BOX 311', 'TALLAHASSEE', 'FL', '32302', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '3ace9d6c84610acb356e1b6a3bc78784', '1', '1', '2026-08-14 18:44:06.264515+00', NULL),
  ('c5f735d6-0085-44a2-b8b0-58d2b1319345', '3d3edf41-9c16-4e73-9f07-6ef837d2d94d', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Municipal Electric PAC (PAC)', 'REPUBLICAN PARTY OF FLA HOUSE MAJORITY', '7500.00', '2023-02-01', 'expenditure', 'MON', 'POLITICAL PARTY CONTRIBUTION', '20241105-GEN', '420 E. JEFFESON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'f89b3ac5212e19a4c0100bb64ef9a4b9', '1', '1', '2026-08-14 18:44:15.570971+00', NULL),
  ('c4b88b04-de04-48be-9737-aeea4f6beeda', 'ecdb525f-9930-4399-b62c-65f17b0a0696', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Ground Water Association PAC (PAC)', 'HOUSE REPUBLICAN MAJORITY', '2500.00', '2023-02-03', 'expenditure', 'MON', 'CONTRIBUTION MADE TO POLITICAL COMMITTEE', '20241105-GEN', '1103 HAYS STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '45d5fa5b27a0af965f60107cfd584bc1', '1', '1', '2026-08-14 18:44:17.331761+00', NULL),
  ('e07240ec-9b7e-4e72-87dd-b475943b1505', 'bf7d091b-821b-463e-b921-9cead7b8ae62', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Floridians for Home Rule PAC (PAC)', 'HOUSE MAJORITY', '5000.00', '2023-02-10', 'expenditure', 'MON', 'POLITICAL COMMITTEE CONTRIBUTION', '20241105-GEN', '402 S. MONROE STREET', 'TALLAAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '82a61b41e934569005d9c93d5cc9cc4e', '1', '1', '2026-08-14 18:44:21.220246+00', NULL),
  ('c038bde2-8c5e-4c63-a571-4657ce170c15', '96ecad55-0cfa-4437-81e6-41e7afd89583', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FRF Political Committee (PAC)', 'REPUBLICAN PARTY OF FLA HOUSE MAJORITY', '10000.00', '2023-02-21', 'expenditure', 'MON', 'DONATION TO POLICITAL COMMITTEE', '20241105-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'bd7968cb5345ea41a617358b4a731545', '1', '1', '2026-08-14 18:44:31.433857+00', NULL),
  ('deb5bd82-4758-4c34-9232-d147c13e77aa', 'c3daeb5b-86d5-4414-ad63-95e85149cbfd', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'OD-EYEPAC (PAC)', 'HOUSE MAJORITY 2022', '25000.00', '2023-06-01', 'expenditure', 'MON', 'TO SUPPORT OPTOMETRY ISSUES', '20241105-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'fcc2c08dcf8047f307397971642e7489', '1', '0.9025', '2026-08-14 18:45:10.315339+00', NULL),
  ('56db4452-d619-4337-ab42-73a23330b438', 'c3daeb5b-86d5-4414-ad63-95e85149cbfd', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'OD-EYEPAC (PAC)', 'HOUSE MAJORITY', '50000.00', '2023-08-03', 'expenditure', 'MON', 'POLITICAL PARTY', '20241105-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '79de79df86971e22b35492965fd18d08', '1', '1', '2026-08-14 18:45:31.077299+00', NULL),
  ('e656b3e1-2717-41ab-9bf5-714952c24e7a', 'c3daeb5b-86d5-4414-ad63-95e85149cbfd', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'OD-EYEPAC (PAC)', 'HOUSE MAJORITY', '50000.00', '2023-10-16', 'expenditure', 'MON', 'TO SUPPORT OPTOMETRY ISSUES', '20241105-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '976b6f8646f6b13ceaa4f9d74f226fed', '1', '1', '2026-08-14 18:45:59.331254+00', NULL),
  ('e323bef7-57f5-4de5-b348-6620f38e0bb3', '3d3edf41-9c16-4e73-9f07-6ef837d2d94d', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Municipal Electric PAC (PAC)', 'REPUBLICAN PARTY OF FLA HOUSE MAJORITY', '10000.00', '2023-11-29', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 EAST JEFFERESON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '2dc7eae87ca0059a1ec0b1a941fc9b68', '1', '1', '2026-08-14 18:46:42.392185+00', NULL),
  ('983f2571-e014-4673-9895-176dd387c75c', 'a6ea1c3c-2123-4297-8c7e-2f45090cc88b', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Cow PAC (PAC)', 'REPUBLICAN PARTY HOUSE MAJORITY', '2500.00', '2024-01-04', 'expenditure', 'MON', 'DONATION', '20241105-GEN', '420 EAST JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '784dbc6e19069d23d9f9758f8a922fd5', '1', '0.98307693', '2026-08-14 18:46:56.747857+00', NULL),
  ('f94116dc-da8d-4c2d-bab2-54f4cdeb3d0a', '556827ca-fa1a-4159-bc87-12bbbd0baba1', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Osteopathic Medical Association  (PAC)', 'REPUBLICAN HOUSE MAJORITY', '1000.00', '2024-01-08', 'expenditure', 'MON', 'CONRTRIBUTION', '20241105-GEN', '420 EAST JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '78252cfd296e3b76c54ee2e1ef63b6aa', '1', '1', '2026-08-14 18:46:58.80157+00', NULL),
  ('f769a660-7910-4db7-8d29-1ba140ba98a1', 'ecdb525f-9930-4399-b62c-65f17b0a0696', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Ground Water Association PAC (PAC)', 'HOUSE MAJORITY', '5000.00', '2024-01-11', 'expenditure', 'MON', 'CONTRIBUTION MADE TO POLITICAL COMMITTEE', '20241105-GEN', '1103 HAYS STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '9408eef3416c21350ebb09bbe90752bb', '1', '1', '2026-08-14 18:46:59.935977+00', NULL),
  ('ecf357c1-bcec-4149-a365-92f20bc41872', 'c3daeb5b-86d5-4414-ad63-95e85149cbfd', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'OD-EYEPAC (PAC)', 'HOUSE MAJORITY', '50000.00', '2024-06-12', 'expenditure', 'MON', 'TO INFLUENCE OPTOMETRY LEGISLATIVE GOALS', '20241105-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'b58bd69754f5456429c3a48a5214c36a', '1', '1', '2026-08-14 18:48:11.824942+00', NULL),
  ('984832ea-0f15-470f-915c-810584b87f4f', '3971034d-9def-44cf-9586-aa96cb8de66f', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Home Builders PAC (PAC)', 'HOUSE MAJORITY', '5000.00', '2024-07-09', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '322 THE CAPITOL, 402 S. MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'cd3f5cb368cf9a8dc33bbf19ab2dd24d', '1', '1', '2026-08-14 18:48:32.627566+00', NULL),
  ('82cda419-3941-42e7-bdeb-2f11d6178028', 'f8de9ec4-2681-456f-9089-c91895c0c114', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Health Care Executive PAC (PAC)', 'FLORIDA REPUBLICAN PARTY-HOUSE MAJORITY', '10000.00', '2024-07-27', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '27e06ccf6fa67d6c79837aa9084d44fc', '1', '1', '2026-08-14 18:49:17.028453+00', NULL),
  ('aee69e7d-a15a-414a-88c3-ae22614a1800', 'f8de9ec4-2681-456f-9089-c91895c0c114', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Health Care Executive PAC (PAC)', 'FLORIDA REPUBLICAN PARTY-HOUSE MAJORITY', '25000.00', '2024-08-08', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '829b2780ca401a506abad7662fd0bc3b', '1', '1', '2026-08-14 18:49:33.255052+00', NULL),
  ('f9b08f26-217d-4450-97c7-5d56dc5d92a5', '96ecad55-0cfa-4437-81e6-41e7afd89583', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FRF Political Committee (PAC)', 'REPUBLICAN PARTY OF FLA -  HOUSE MAJORITY', '15000.00', '2024-08-09', 'expenditure', 'MON', 'DONATION TO POLITICAL COMMITTEE', '20241105-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '2db894b7a28862a138ec2d3f2379b259', '1', '1', '2026-08-14 18:49:34.421294+00', NULL),
  ('919cbf8a-f414-4762-9c4c-302cd9911ff8', 'daa0ba2a-5b5e-4db0-b364-eaed451de04f', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'ChiroPAC PC (PAC)', 'HOUSE MAJORITY', '25000.00', '2024-08-16', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E. JEFFERSON ST.', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'dd5e65a83ff4ec50cea61bb342c44f06', '1', '1', '2026-08-14 18:49:42.064331+00', NULL),
  ('38b415a2-cdf0-4173-8621-5ea4c6da94e9', '8d4bb206-1e3e-4704-98b7-280992cf36bc', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Optometry PAC (PAC)', 'HOUSE MAJORITY', '100000.00', '2024-09-04', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '5a3f3568eee979fc8ecf2f297fe5b31c', '1', '1', '2026-08-14 18:49:54.418122+00', NULL),
  ('cdf3a106-b839-448f-b95e-29161589d211', 'bf7d091b-821b-463e-b921-9cead7b8ae62', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Floridians for Home Rule PAC (PAC)', 'HOUSE MAJORITY REPUBLICAN PARTY', '10000.00', '2024-09-09', 'expenditure', 'MON', 'REPUBLICAN PARTY CONTRIBUTION', '20241105-GEN', '402 S. MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'f4c906210b3ab713c560a3e0df83121d', '1', '1', '2026-08-14 18:49:57.197322+00', NULL),
  ('fa264046-3354-4f45-90f5-a6d335aeb288', '3d3edf41-9c16-4e73-9f07-6ef837d2d94d', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Municipal Electric PAC (PAC)', 'HOUSE MAJORITY', '10000.00', '2024-09-23', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '402 SOUTH MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'a4289c1aa27d5d0a8bb8288a5ca82b46', '1', '1', '2026-08-14 18:50:11.225271+00', NULL),
  ('a3631d6a-5ccf-4e2b-a348-f8ff0b372854', 'f8de9ec4-2681-456f-9089-c91895c0c114', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Health Care Executive PAC (PAC)', 'FLORIDA REPUBLICAN PARTY-HOUSE MAJORITY', '10000.00', '2024-10-07', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 EAST JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'cb2e5f5261a1538d3e2a7f6971a30add', '1', '1', '2026-08-14 18:50:22.469948+00', NULL),
  ('6332c037-449d-4a28-834f-4f76c0fc0bba', '3971034d-9def-44cf-9586-aa96cb8de66f', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Home Builders PAC (PAC)', 'REPUBLICAN PARTY OF FL HOUSE MAJORITY', '20000.00', '2024-10-17', 'expenditure', 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E. JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'b1786ed99a7fe54f098158c01b255cb5', '1', '0.95125', '2026-08-14 18:50:34.082905+00', NULL),
  ('11e5999d-1526-4961-8068-62732f759d6f', '6a72ae65-7330-4156-8269-d75a444928ec', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Committee of Automotive Retailers Politi (PAC)', 'HOUSE MAJORITY C/O RPOF', '100000.00', '2024-10-21', 'expenditure', 'MON', 'PARTY SUPPORT', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'dcd943154d31deed82c6770aef487e56', '1', '0.94076926', '2026-08-14 18:50:37.978011+00', NULL),
  ('2641eff6-9704-4842-bb0b-7ad5dcb88b2f', '3d3edf41-9c16-4e73-9f07-6ef837d2d94d', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Municipal Electric PAC (PAC)', 'HOUSE MAJORITY', '2500.00', '2025-01-17', 'expenditure', 'MON', 'POLITICAL COMMITTEE CONTRIBUTION', '20261103-GEN', '420 EAST JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'b1aed44ce94aba9ba16a9683618dcd03', '1', '1', '2026-08-14 18:55:35.098403+00', NULL),
  ('03c7f846-7706-4a81-a982-424ff7f882ac', '556827ca-fa1a-4159-bc87-12bbbd0baba1', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Osteopathic Medical Association  (PAC)', 'REPUBLICAN HOUSE MAJORITY - RPOF', '2500.00', '2025-01-24', 'expenditure', 'MON', 'CONTRIBUTION POLITICAL COMMITTEE', '20261103-GEN', '420 EAST JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '27a08cd48de193bc89218d11dd5f13da', '1', '0.9320588', '2026-08-14 18:55:37.530423+00', NULL),
  ('14151e62-02fd-4ca8-89d1-152a61459573', 'bf7d091b-821b-463e-b921-9cead7b8ae62', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Floridians for Home Rule PAC (PAC)', 'HOUSE MAJORITY REPUBLICAN PARTY', '5000.00', '2025-02-04', 'expenditure', 'MON', 'REPUBLICAN PARTY CONTRIBUTION', '20261103-GEN', '402 S. MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'c56a31949f15a213b100ffdbb89361b6', '1', '0.96', '2026-08-14 18:55:42.284055+00', NULL),
  ('f77bd053-4303-431f-8c93-c29b5d2783ec', '3971034d-9def-44cf-9586-aa96cb8de66f', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Home Builders PAC (PAC)', 'HOUSE MAJORITY', '10000.00', '2025-02-17', 'expenditure', 'MON', 'CONTRIBUTION', '20261103-GEN', '322 THE CAPITOL, 402 SOUTH MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'd7953f090aafaf0f59ad870533955a0b', '1', '1', '2026-08-14 18:55:48.374923+00', NULL),
  ('a4c0d2d4-3e38-4125-8ab7-b6802a08f1aa', '96ecad55-0cfa-4437-81e6-41e7afd89583', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FRF Political Committee (PAC)', 'REPUBLICAN PART OF FLORIDA-HOUSE MAJORITY', '25000.00', '2025-06-12', 'expenditure', 'MON', 'DONATION TO POLITICAL COMMITTEE', '20261103-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '579d161fe26c0d83498773d8cbbd9147', '1', '1', '2026-08-14 18:56:28.076235+00', NULL),
  ('a62b37df-77b8-4619-aaec-b2d17e9d6c36', '3971034d-9def-44cf-9586-aa96cb8de66f', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Home Builders PAC (PAC)', 'HOUSE MAJORITY', '25000.00', '2025-06-23', 'expenditure', 'MON', 'CONTRIBUTION', '20261103-GEN', '322 THE CAPITOL, 402 SOUTH MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '08da046b8fe8b89cabd80ea567049504', '1', '1', '2026-08-14 18:56:30.774987+00', NULL),
  ('cf540a30-b191-404b-828c-0fa4a04004be', '18c9023b-f97a-4ae9-8f60-e45c0a0b9361', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Associated Builders and Contractors (ABC (PAC)', 'HOUSE MAJORITY, RPOF', '1000.00', '2025-08-05', 'expenditure', 'CAN', 'POLITICAL COMMITTEE CONTRIBUTION', '20261103-GEN', '420 EAST JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '3f3b97c0e90cffebfdcac8dec1b5425b', '1', '0.99', '2026-08-14 18:56:43.973537+00', NULL),
  ('6d236795-eb17-41db-9538-7262ac7d31a5', '8e92cf3f-1244-4d22-b04c-2392d399ff44', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FAIAPAC (PAC)', 'HOUSE MAJORITY', '25000.00', '2025-08-25', 'expenditure', 'MON', 'POLITICAL CONTRIBUTION 8/2025', '20261103-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '70f288b5c0df59dffcf6e1ca2896bc03', '1', '1', '2026-08-14 18:56:51.597283+00', NULL),
  ('d37a7e23-a965-407b-8465-47075312318b', 'd494d831-a4e4-409a-86e8-bd88e7cc87f7', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'IMPACT (PAC)', 'HOUSE MAJORITY', '25000.00', '2025-08-25', 'expenditure', 'MON', 'POLITICAL CONTRIBUTION 8/2025', '20261103-GEN', '420 EAST JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '0f1785fe58366e5e3cdae482988ef76e', '1', '1', '2026-08-14 18:56:50.768498+00', NULL),
  ('64dac1c1-98d9-4f07-8658-9da0a52081f3', 'bf7d091b-821b-463e-b921-9cead7b8ae62', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Floridians for Home Rule PAC (PAC)', 'HOUSE MAJORITY REPUBLICAN PARTY', '25000.00', '2025-09-02', 'expenditure', 'MON', 'REPUBLICAN PARTY CONTRIBUTION', '20261103-GEN', '402 S. MONROE STREET', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'b56d45f5062b5c1645986bb86ec46b9a', '1', '1', '2026-08-14 18:56:54.171319+00', NULL),
  ('934a5f7a-8d51-43af-881d-028243fc9bc0', '96ecad55-0cfa-4437-81e6-41e7afd89583', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FRF Political Committee (PAC)', 'REPUBLICAN PART OF FLORIDA-HOUSE MAJORITY', '25000.00', '2025-09-08', 'expenditure', 'MON', 'DONATION TO POLICITAL COMMITTEE', '20261103-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', '5d84962d1a06bbfe24bb13a3d285c04f', '1', '1', '2026-08-14 18:57:20.211911+00', NULL),
  ('78bc35ea-27ca-43a1-8093-7bbdc000bab4', '78056db9-8f97-4bbb-b3f9-49caba5fdcf3', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Police Benevolent Association In (PAC)', 'RPOF HOUSE MAJORITY', '25000.00', '2025-09-11', 'expenditure', 'MON', 'CONTRIBUTION', '20261103-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'f8c3fe502c4861515ec7bd07f9e4ea56', '1', '1', '2026-08-14 18:57:21.278015+00', NULL),
  ('d4396486-76cc-496a-bd47-64bf927e4d33', '96ecad55-0cfa-4437-81e6-41e7afd89583', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'FRF Political Committee (PAC)', 'REPUBLICAN PART OF FLORIDA-HOUSE MAJORITY', '10000.00', '2025-12-02', 'expenditure', 'MON', 'DONATION TO POLITICAL COMMITTEE', '20261103-GEN', '420 E JEFFERSON ST', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'c1f497b33116a022bc26ab1dda1752bc', '1', '1', '2026-08-14 18:58:00.691302+00', NULL),
  ('9a2b512f-b053-436f-b675-76c16c4c1aa5', '5342d742-624a-4c96-b59d-33495c657902', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Friends of Landscape Architecture Politi (PAC)', 'RPOF HOUSE MAJORITY', '8000.00', '2026-01-08', 'expenditure', 'MON', 'CONTRIBUTION TO POLITICAL COMMITTEE', '20261103-GEN', '527 EAST PARK AVENUE', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'f968cc285e93c4c4f668718c779627a4', '1', '1', '2026-08-14 18:58:12.962143+00', NULL),
  ('cd53f27d-302f-45ef-a81c-6c4ce18a1133', '8d273e7a-0ab8-4a8e-9190-ef476693a889', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Carlton Fields Political Committee (PAC)', 'HOUSE MAJORITY', '2500.00', '2026-01-09', 'expenditure', 'MON', 'PAC', '20261103-GEN', '527 E. PARK AVE', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'b91a073df25deb8ce435f7de059781bb', '1', '1', '2026-08-14 18:58:13.93887+00', NULL),
  ('ea42e124-6b14-4e43-9896-6ca709a52f74', 'ae0a2813-7697-4f93-8238-2083af36baff', '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc', 'Florida Nursery, Growers & Landscape Ass (PAC)', 'FLORIDA HOUSE MAJORITY OFFICE', '5000.00', '2026-07-27', 'expenditure', 'MON', 'CAMPAIGN CONTRIBUTION', '20261103-GEN', '402 S MONROE ST', 'TALLAHASSEE', 'FL', '32399', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2', 'e98fa6daec7a583f9806df42d56c44fa', '1', '1', '2026-08-14 23:06:01.355019+00', NULL)
;

-- The one row the collapse did not take. It is still on the party.
UPDATE transactions
   SET to_entity_id = '4e3e130a-c82d-4dc1-af7e-59eaf30b10bc'
 WHERE id = '5b7b6e53-a589-4314-9c6f-e4eee6f1f7c8';

-- Clear the tombstones for the 46 rows that are alive again.
DELETE FROM transaction_tombstones
 WHERE id IN (
  '03c7f846-7706-4a81-a982-424ff7f882ac',
  '103aca13-41ec-4cc3-967b-5f0a63ba7951',
  '11e5999d-1526-4961-8068-62732f759d6f',
  '14151e62-02fd-4ca8-89d1-152a61459573',
  '2641eff6-9704-4842-bb0b-7ad5dcb88b2f',
  '38b415a2-cdf0-4173-8621-5ea4c6da94e9',
  '555a4c33-81e6-4165-aae8-07e628ca8c0d',
  '56db4452-d619-4337-ab42-73a23330b438',
  '5b7b6e53-a589-4314-9c6f-e4eee6f1f7c8',
  '6332c037-449d-4a28-834f-4f76c0fc0bba',
  '64dac1c1-98d9-4f07-8658-9da0a52081f3',
  '6d236795-eb17-41db-9538-7262ac7d31a5',
  '78bc35ea-27ca-43a1-8093-7bbdc000bab4',
  '82cda419-3941-42e7-bdeb-2f11d6178028',
  '919cbf8a-f414-4762-9c4c-302cd9911ff8',
  '934a5f7a-8d51-43af-881d-028243fc9bc0',
  '94148794-358d-4df8-ae57-9035b1372ba5',
  '983f2571-e014-4673-9895-176dd387c75c',
  '984832ea-0f15-470f-915c-810584b87f4f',
  '9a2b512f-b053-436f-b675-76c16c4c1aa5',
  'a3631d6a-5ccf-4e2b-a348-f8ff0b372854',
  'a4c0d2d4-3e38-4125-8ab7-b6802a08f1aa',
  'a5ee5c25-bf27-4b14-8786-24f8bf916358',
  'a62b37df-77b8-4619-aaec-b2d17e9d6c36',
  'aee69e7d-a15a-414a-88c3-ae22614a1800',
  'c038bde2-8c5e-4c63-a571-4657ce170c15',
  'c1ac91ba-7ad3-4c3c-9efa-5d2986a90ef6',
  'c4b88b04-de04-48be-9737-aeea4f6beeda',
  'c5f735d6-0085-44a2-b8b0-58d2b1319345',
  'cd53f27d-302f-45ef-a81c-6c4ce18a1133',
  'cdf3a106-b839-448f-b95e-29161589d211',
  'cf540a30-b191-404b-828c-0fa4a04004be',
  'd37a7e23-a965-407b-8465-47075312318b',
  'd4396486-76cc-496a-bd47-64bf927e4d33',
  'deb5bd82-4758-4c34-9232-d147c13e77aa',
  'e07240ec-9b7e-4e72-87dd-b475943b1505',
  'e323bef7-57f5-4de5-b348-6620f38e0bb3',
  'e656b3e1-2717-41ab-9bf5-714952c24e7a',
  'ea42e124-6b14-4e43-9896-6ca709a52f74',
  'ecf357c1-bcec-4149-a365-92f20bc41872',
  'f769a660-7910-4db7-8d29-1ba140ba98a1',
  'f77bd053-4303-431f-8c93-c29b5d2783ec',
  'f908ce14-fcea-4687-b84f-fc734ec930aa',
  'f94116dc-da8d-4c2d-bab2-54f4cdeb3d0a',
  'f9a38d8f-9e94-4c9f-9e27-2a69849377ff',
  'f9b08f26-217d-4450-97c7-5d56dc5d92a5',
  'fa264046-3354-4f45-90f5-a6d335aeb288'
 );

COMMIT;

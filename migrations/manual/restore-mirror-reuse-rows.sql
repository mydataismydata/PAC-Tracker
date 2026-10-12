-- Put back 16 expenditures that mirror collapse deleted against a receipt
-- another payment already held.
--
-- Run on the ingest machine only, after record-mirror-pairs.sql. The rows go
-- in under new ids, the way a filing that a later sweep brings back does, so
-- their old tombstones stay true for the old ids and the next delta carries
-- them to the deployment box as new rows. Nothing needs running over there.
--
-- What happened. Until 2026-10-12 mirror collapse recorded no pair, and
-- `rebuildAll` repeated the sweep until it deleted nothing. A receipt paired
-- in one pass looked free in the next, so it could absorb a second payment.
-- These 16 are payments whose only receipts in the window were held by another
-- deletion. Each is a separate payment the payer reported and the recipient
-- did not book a second time, which the one-to-one rule keeps. 14 more were
-- deleted the same way but are the payer filing one payment twice on the same
-- day; they stay deleted.
--
-- Provenance. The values are the rows as they stood in the 2026-09-05 full
-- dump, with the payer and recipient set to the nodes holding the receipts
-- today. Their receipts are on record after record-mirror-pairs.sql, so the
-- next rebuild leaves them in place.
--
-- $231,400 in all, $200,000 of it four Florida Chamber of Commerce PAC
-- payments to the Republican Party of Florida.
--
-- Safe to run twice: a row hash already present is skipped.
BEGIN;

INSERT INTO transactions (
  id, from_entity_id, to_entity_id, raw_from_name, raw_to_name, amount, txn_date,
  direction, txn_type_code, inkind_description, election_cycle, from_address,
  from_city, from_state, from_zip, from_occupation, source_id, source_row_hash,
  from_confidence, to_confidence
) VALUES
  (gen_random_uuid(), '94c237c5-ebf4-46ae-ac2f-0d3a997b1e31'::uuid, 'bb4d18e3-587f-4374-ada1-b626c61bb1b9'::uuid, 'AT&T Florida PAC (PAC)', 'TRACIE DAVIS CAMPAIGN ACCOUNT', '1000.00'::numeric, '2023-03-07'::date, 'expenditure'::txn_direction, 'CAN', 'SENATE FL 5 TRACIE DAVIS, STATE SENATE 5TH FL', '20241105-GEN', '221 NORTH HOGAN STREET, SUITE 382', 'JACKSONVILLE', 'FL', '32202', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, 'a18e219783d3b3b769b5acd543b15bd0', '1'::real, '1'::real),
  (gen_random_uuid(), '81597e52-462c-42c9-937c-e14dba7815ec'::uuid, '58ab0474-6b52-40bf-8522-93597b79b9d4'::uuid, 'Florida Chamber of Commerce PAC (PAC)', 'REPUBLICAN PARTY OF FLORIDA', '50000.00'::numeric, '2023-09-18'::date, 'expenditure'::txn_direction, 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '2ca29713ec154ded928be91eeb931af4', '1'::real, '1'::real),
  (gen_random_uuid(), '81597e52-462c-42c9-937c-e14dba7815ec'::uuid, '58ab0474-6b52-40bf-8522-93597b79b9d4'::uuid, 'Florida Chamber of Commerce PAC (PAC)', 'REPUBLICAN PARTY OF FLORIDA - HOUSE MAJORITY', '25000.00'::numeric, '2024-08-02'::date, 'expenditure'::txn_direction, 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '95918fa50292ec109ead3e76f93b8972', '1'::real, '1'::real),
  (gen_random_uuid(), '81597e52-462c-42c9-937c-e14dba7815ec'::uuid, '58ab0474-6b52-40bf-8522-93597b79b9d4'::uuid, 'Florida Chamber of Commerce PAC (PAC)', 'REPUBLICAN PARTY OF FLORIDA', '75000.00'::numeric, '2024-09-05'::date, 'expenditure'::txn_direction, 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '10d038215b413a01aad686ab526fdbfc', '1'::real, '1'::real),
  (gen_random_uuid(), '81597e52-462c-42c9-937c-e14dba7815ec'::uuid, '58ab0474-6b52-40bf-8522-93597b79b9d4'::uuid, 'Florida Chamber of Commerce PAC (PAC)', 'REPUBLICAN PARTY OF FLORIDA - HOUSE MAJORITY', '50000.00'::numeric, '2024-10-04'::date, 'expenditure'::txn_direction, 'MON', 'CONTRIBUTION', '20241105-GEN', '420 E JEFFERSON STREET', 'TALLAHASSEE', 'FL', '32301', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, 'fcc9daa5ddba33b89eb2f7ee5d7ba1f0', '1'::real, '1'::real),
  (gen_random_uuid(), '1601f310-d2f0-4b0f-8694-8a35274d6124'::uuid, '26c42f1b-8c96-4aac-90d8-572f484f950e'::uuid, 'Florida Dental Association Political Act (PAC)', 'DEBBIE MAYFIELD CAMPAIGN FUND', '500.00'::numeric, '2024-09-20'::date, 'expenditure'::txn_direction, 'CAN', 'HOUSE FL 32 DEBBIE MAYFIELD, STATE HOUSE 32ND FL', '20241105-GEN', '3100 NORTH RIVERSIDE DRIVE', 'INDIALANTIC', 'FL', '32903', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '573abb2ed3cc824a9db8b140bdabc41b', '1'::real, '1'::real),
  (gen_random_uuid(), '5f050cb1-3152-4593-91bb-d2fd2ffe1133'::uuid, 'd59e3350-6218-4143-8d8f-b4e67abc26fe'::uuid, 'Florida Health Alliance PC (PAC)', 'DANA TRABULSY CAMPAIGN', '1000.00'::numeric, '2024-09-05'::date, 'expenditure'::txn_direction, 'CAN', 'HOUSE', '20241105-GEN', '5428 STATELY OAKS STREET', 'FORT PIERCE, FL 34981', 'FL', '34981', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '3f3c9c8e1b8739dd6a2da5f805a10df2', '1'::real, '1'::real),
  (gen_random_uuid(), '78056db9-8f97-4bbb-b3f9-49caba5fdcf3'::uuid, '2b5c3e4a-cb7b-4e14-ba9d-725795a36edd'::uuid, 'Florida Police Benevolent Association In (PAC)', 'FRSCC', '25000.00'::numeric, '2025-10-08'::date, 'expenditure'::txn_direction, 'MON', 'CONTRIBUTION', '20261103-GEN', '2640A MITCHAM DR.', 'TALLAHASSEE', 'FL', NULL, NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, 'b385fac4a91f01e47511ca206a196ad2', '1'::real, '1'::real),
  (gen_random_uuid(), '0ebd162a-9d72-4ff3-bc30-ce05950febc5'::uuid, '229205fb-5f9a-405f-b74d-ae8e3a242aed'::uuid, 'GrayRobinson, P.A., Florida Political Ac (PAC)', 'CHANEY, LINDA', '1000.00'::numeric, '2024-04-12'::date, 'expenditure'::txn_direction, 'CAN', 'CONTRIBUTION - STATE REPRESENTATIVE - DISTRICT 61', '20241105-GEN', 'C/O 2055 NW DIAMOND CREEK WAY', 'JENSEN BEACH', 'FL', '34957', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '57b07bdf7dff41232ddcdcb340aa482c', '1'::real, '1'::real),
  (gen_random_uuid(), 'd6d43194-1c0b-45e8-8e88-a9d6227be76d'::uuid, '79c23128-22f5-4259-a6a5-31e484c26e25'::uuid, 'Plumbers & Pipefitters Local 123 PAC Fun (PAC)', 'SUAREZ, MIKE', '1000.00'::numeric, '2026-06-18'::date, 'expenditure'::txn_direction, 'CAN', 'STATE REP DISTRICT 64', '20261103-GEN', 'PO BOX 4927', 'TAMPA', 'FL', '33606', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '43b314860fb897a4fc20b5a4f81bec25', '1'::real, '1'::real),
  (gen_random_uuid(), '0a72561f-91f1-415e-a54c-6ef1bf68cf10'::uuid, 'c6630e70-9488-457a-9b65-9ee365540b81'::uuid, 'Ponte Vedra Democratic Club', 'ST JOHNS COUNTY DEC', '100.00'::numeric, '2017-05-05'::date, 'expenditure'::txn_direction, 'MO', 'DONATION', '20181106-GEN', 'PO BOX 4200', 'ST AUGUSTINE', 'FL', '32085', NULL, '36c7193a-bb16-4b54-b1b7-7d3ea276e303'::uuid, 'f136a0793e53214fc0cb6f08c1623aea', '1'::real, '1'::real),
  (gen_random_uuid(), '0a72561f-91f1-415e-a54c-6ef1bf68cf10'::uuid, 'c6630e70-9488-457a-9b65-9ee365540b81'::uuid, 'Ponte Vedra Democratic Club', 'ST JOHNS COUNTY DEC', '100.00'::numeric, '2017-06-09'::date, 'expenditure'::txn_direction, 'MO', 'DONATION', '20181106-GEN', 'PO BOX 4200', 'ST AUGUSTINE', 'FL', '320985', NULL, '36c7193a-bb16-4b54-b1b7-7d3ea276e303'::uuid, 'a3b05f5232aa73e6ef4c6165fdd00aa6', '1'::real, '1'::real),
  (gen_random_uuid(), '0a72561f-91f1-415e-a54c-6ef1bf68cf10'::uuid, 'c6630e70-9488-457a-9b65-9ee365540b81'::uuid, 'Ponte Vedra Democratic Club', 'ST JOHNS COUNTY DEC', '100.00'::numeric, '2017-09-28'::date, 'expenditure'::txn_direction, 'MO', 'DONATION', '20181106-GEN', 'PO BOX 4200', 'ST AUGUSTINE', 'FL', '32085', NULL, '36c7193a-bb16-4b54-b1b7-7d3ea276e303'::uuid, '1cf7a4fd9cccf526f341e95ce8c22b87', '1'::real, '1'::real),
  (gen_random_uuid(), '0a72561f-91f1-415e-a54c-6ef1bf68cf10'::uuid, 'c6630e70-9488-457a-9b65-9ee365540b81'::uuid, 'Ponte Vedra Democratic Club', 'ST JOHNS COUNTY DEC', '100.00'::numeric, '2017-10-11'::date, 'expenditure'::txn_direction, 'MO', 'DONATION', '20181106-GEN', 'PO BOX 4200', 'ST AUGUSTINE', 'FL', '32085', NULL, '36c7193a-bb16-4b54-b1b7-7d3ea276e303'::uuid, 'fc5a363ea0638c7b6ec91c8cf9d68087', '1'::real, '1'::real),
  (gen_random_uuid(), 'ed15b6b5-cc07-47c1-87f5-2336fc627a88'::uuid, 'bb4d18e3-587f-4374-ada1-b626c61bb1b9'::uuid, 'Ruth''s List Florida (PAC)', 'TRACIE DAVIS CAMPAIGN', '500.00'::numeric, '2024-08-02'::date, 'expenditure'::txn_direction, 'CAN', 'DUVAL COUNTY STATE SENATOR CANDIDATE CONTRIBUTION', '20241105-GEN', '221 N HOGAN ST # 382', 'JACKSONVILLE', 'FL', '32202', NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '916a16d2fd41cd07fd68db7e7b95f0d9', '1'::real, '1'::real),
  (gen_random_uuid(), '8052316f-03e9-4c22-80ea-54feb79d98ab'::uuid, 'fb493b61-a626-44c6-84b8-d7bc34b2de8f'::uuid, 'Suncoast PAC (PAC)', 'STAN, MCCLAIN', '1000.00'::numeric, '2024-10-25'::date, 'expenditure'::txn_direction, 'CAN', 'CAMPAIGN CONTRIBUTION', '20241105-GEN', '526 EAST PARK AVENUE', 'TALLAHASSEE', 'FL', NULL, NULL, 'b2f37c2d-5b0b-40a5-a29e-05d92feaa9a2'::uuid, '4d416c00a27e583132ae7c411d954163', '1'::real, '1'::real)
ON CONFLICT (source_row_hash) DO NOTHING;

COMMIT;

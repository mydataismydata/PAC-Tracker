-- Florida's sugar producers, labelled Sugar rather than generically Agriculture.
--
-- Sugar is already its own label here: Florida Crystals, United States Sugar
-- Corporation and US Sugar carry it. The rest of the industry fell through to
-- Agriculture, which put a Clewiston sugar mill in the same bucket as a cattle
-- ranch and hid what is one of the largest organized giving blocs in Florida
-- politics.
--
-- The label has to be set per company. Every sugar producer files its
-- occupation as "AGRICULTURE", "FARMING" or "AGRI-BUSINESS", so no occupation
-- rule can separate sugar from farming; and a name rule matching "sugar" would
-- sweep in a liquor store, a preschool, a realtor, an antiques mall and three
-- mobile home parks. `NAME_OVERRIDES` in src/lib/ingest/industry.ts now names
-- each of these, which is how Florida Crystals and US Sugar were already
-- handled, so a database built from scratch classifies them correctly.
--
-- This sets the label on the rows already in the database.
-- `ingest backfill-industry` only fills NULLs, and `--force` would reclassify
-- every reviewed entity in the graph.
--
-- The two Clewiston and Belle Glade survivors already read Sugar: the first
-- from the override on its own name, the second because its set-kind
-- correction re-derived the industry after the override existed.
UPDATE entities
   SET industry = 'Sugar'
 WHERE id IN (
   'fec2c228-56f7-4f75-8691-340fc4e672b9',  -- NEW HOPE SUGAR COMPANY, Loxahatchee
   'd756f3d1-84ed-499f-a082-b266f29f00e7',  -- SUGAR FARMS CO-OP, Loxahatchee
   '7d9bc90a-3469-41a3-8caa-01f438c4880a',  -- DEEP SOUTH SUGAR CORP, Okeechobee
   '2a74ed7a-3e7d-4dc1-a83e-c087b05dbd3c',  -- PIONEER RANCH & SUGAR FARMS, INC., Belle Glade
   '89bf716d-efdf-47b4-a7ef-018ecd33918e'   -- SUGAR DADDY CANE, INC., LaBelle
 );

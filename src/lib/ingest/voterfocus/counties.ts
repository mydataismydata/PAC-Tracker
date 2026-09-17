/**
 * Florida counties served by VoterFocus.
 *
 * VoterFocus (VR Systems) hosts the campaign finance portal for every one of
 * Florida's 67 Supervisors of Elections. The county is a single query
 * parameter, so one adapter covers all of them — this registry is only a map
 * from slug to display name plus the code used for jurisdictions.
 *
 * The slug is the county's name in lower case with everything but letters
 * removed, and every one below was confirmed live against candidate_pr.php on
 * 2026-09-17: all 67 answered with their own filers and their own offices. A
 * slug the portal does not know answers HTTP 400, so a wrong one fails loudly
 * rather than returning nothing.
 *
 * Listed alphabetically. Being here means the portal answers, not that the
 * county has been swept.
 */

export interface VoterFocusCounty {
  /** The `c=` query parameter. */
  slug: string;
  /** Display name, without the word "County". */
  name: string;
  /** Jurisdiction code used in the database, e.g. FL-STJOHNS. */
  code: string;
}

export const VOTERFOCUS_COUNTIES: VoterFocusCounty[] = [
  { slug: 'alachua',      name: 'Alachua',      code: 'FL-ALACHUA' },
  { slug: 'baker',        name: 'Baker',        code: 'FL-BAKER' },
  { slug: 'bay',          name: 'Bay',          code: 'FL-BAY' },
  { slug: 'bradford',     name: 'Bradford',     code: 'FL-BRADFORD' },
  { slug: 'brevard',      name: 'Brevard',      code: 'FL-BREVARD' },
  { slug: 'broward',      name: 'Broward',      code: 'FL-BROWARD' },
  { slug: 'calhoun',      name: 'Calhoun',      code: 'FL-CALHOUN' },
  { slug: 'charlotte',    name: 'Charlotte',    code: 'FL-CHARLOTTE' },
  { slug: 'citrus',       name: 'Citrus',       code: 'FL-CITRUS' },
  { slug: 'clay',         name: 'Clay',         code: 'FL-CLAY' },
  { slug: 'collier',      name: 'Collier',      code: 'FL-COLLIER' },
  { slug: 'columbia',     name: 'Columbia',     code: 'FL-COLUMBIA' },
  { slug: 'desoto',       name: 'DeSoto',       code: 'FL-DESOTO' },
  { slug: 'dixie',        name: 'Dixie',        code: 'FL-DIXIE' },
  { slug: 'duval',        name: 'Duval',        code: 'FL-DUVAL' },
  { slug: 'escambia',     name: 'Escambia',     code: 'FL-ESCAMBIA' },
  { slug: 'flagler',      name: 'Flagler',      code: 'FL-FLAGLER' },
  { slug: 'franklin',     name: 'Franklin',     code: 'FL-FRANKLIN' },
  { slug: 'gadsden',      name: 'Gadsden',      code: 'FL-GADSDEN' },
  { slug: 'gilchrist',    name: 'Gilchrist',    code: 'FL-GILCHRIST' },
  { slug: 'glades',       name: 'Glades',       code: 'FL-GLADES' },
  { slug: 'gulf',         name: 'Gulf',         code: 'FL-GULF' },
  { slug: 'hamilton',     name: 'Hamilton',     code: 'FL-HAMILTON' },
  { slug: 'hardee',       name: 'Hardee',       code: 'FL-HARDEE' },
  { slug: 'hendry',       name: 'Hendry',       code: 'FL-HENDRY' },
  { slug: 'hernando',     name: 'Hernando',     code: 'FL-HERNANDO' },
  { slug: 'highlands',    name: 'Highlands',    code: 'FL-HIGHLANDS' },
  { slug: 'hillsborough', name: 'Hillsborough', code: 'FL-HILLSBOROUGH' },
  { slug: 'holmes',       name: 'Holmes',       code: 'FL-HOLMES' },
  { slug: 'indianriver',  name: 'Indian River', code: 'FL-INDIANRIVER' },
  { slug: 'jackson',      name: 'Jackson',      code: 'FL-JACKSON' },
  { slug: 'jefferson',    name: 'Jefferson',    code: 'FL-JEFFERSON' },
  { slug: 'lafayette',    name: 'Lafayette',    code: 'FL-LAFAYETTE' },
  { slug: 'lake',         name: 'Lake',         code: 'FL-LAKE' },
  { slug: 'lee',          name: 'Lee',          code: 'FL-LEE' },
  { slug: 'leon',         name: 'Leon',         code: 'FL-LEON' },
  { slug: 'levy',         name: 'Levy',         code: 'FL-LEVY' },
  { slug: 'liberty',      name: 'Liberty',      code: 'FL-LIBERTY' },
  { slug: 'madison',      name: 'Madison',      code: 'FL-MADISON' },
  { slug: 'manatee',      name: 'Manatee',      code: 'FL-MANATEE' },
  { slug: 'marion',       name: 'Marion',       code: 'FL-MARION' },
  { slug: 'martin',       name: 'Martin',       code: 'FL-MARTIN' },
  { slug: 'miamidade',    name: 'Miami-Dade',   code: 'FL-MIAMIDADE' },
  { slug: 'monroe',       name: 'Monroe',       code: 'FL-MONROE' },
  { slug: 'nassau',       name: 'Nassau',       code: 'FL-NASSAU' },
  { slug: 'okaloosa',     name: 'Okaloosa',     code: 'FL-OKALOOSA' },
  { slug: 'okeechobee',   name: 'Okeechobee',   code: 'FL-OKEECHOBEE' },
  { slug: 'orange',       name: 'Orange',       code: 'FL-ORANGE' },
  { slug: 'osceola',      name: 'Osceola',      code: 'FL-OSCEOLA' },
  { slug: 'palmbeach',    name: 'Palm Beach',   code: 'FL-PALMBEACH' },
  { slug: 'pasco',        name: 'Pasco',        code: 'FL-PASCO' },
  { slug: 'pinellas',     name: 'Pinellas',     code: 'FL-PINELLAS' },
  { slug: 'polk',         name: 'Polk',         code: 'FL-POLK' },
  { slug: 'putnam',       name: 'Putnam',       code: 'FL-PUTNAM' },
  { slug: 'santarosa',    name: 'Santa Rosa',   code: 'FL-SANTAROSA' },
  { slug: 'sarasota',     name: 'Sarasota',     code: 'FL-SARASOTA' },
  { slug: 'seminole',     name: 'Seminole',     code: 'FL-SEMINOLE' },
  { slug: 'stjohns',      name: 'St. Johns',    code: 'FL-STJOHNS' },
  { slug: 'stlucie',      name: 'St. Lucie',    code: 'FL-STLUCIE' },
  { slug: 'sumter',       name: 'Sumter',       code: 'FL-SUMTER' },
  { slug: 'suwannee',     name: 'Suwannee',     code: 'FL-SUWANNEE' },
  { slug: 'taylor',       name: 'Taylor',       code: 'FL-TAYLOR' },
  { slug: 'union',        name: 'Union',        code: 'FL-UNION' },
  { slug: 'volusia',      name: 'Volusia',      code: 'FL-VOLUSIA' },
  { slug: 'wakulla',      name: 'Wakulla',      code: 'FL-WAKULLA' },
  { slug: 'walton',       name: 'Walton',       code: 'FL-WALTON' },
  { slug: 'washington',   name: 'Washington',   code: 'FL-WASHINGTON' },
];

export function findCounty(slug: string): VoterFocusCounty | undefined {
  const needle = slug.toLowerCase().replace(/[^a-z]/g, '');
  return VOTERFOCUS_COUNTIES.find((c) => c.slug === needle);
}

/**
 * Florida counties served by VoterFocus.
 *
 * VoterFocus (VR Systems) hosts the campaign finance portal for a large share
 * of Florida's 67 Supervisors of Elections. The county is a single query
 * parameter, so one adapter covers all of them — this registry is only a map
 * from slug to display name plus the FIPS-style code used for jurisdictions.
 *
 * Slugs verified live against candidate_pr.php. Counties not listed here may
 * still work; add them once confirmed rather than guessing, since an unknown
 * slug silently returns an empty page rather than an error.
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
  { slug: 'stjohns', name: 'St. Johns', code: 'FL-STJOHNS' },
  { slug: 'miamidade', name: 'Miami-Dade', code: 'FL-MIAMIDADE' },
  { slug: 'broward', name: 'Broward', code: 'FL-BROWARD' },
  { slug: 'palmbeach', name: 'Palm Beach', code: 'FL-PALMBEACH' },
  { slug: 'hillsborough', name: 'Hillsborough', code: 'FL-HILLSBOROUGH' },
  { slug: 'orange', name: 'Orange', code: 'FL-ORANGE' },
  { slug: 'duval', name: 'Duval', code: 'FL-DUVAL' },
  { slug: 'pinellas', name: 'Pinellas', code: 'FL-PINELLAS' },
  { slug: 'lee', name: 'Lee', code: 'FL-LEE' },
  { slug: 'polk', name: 'Polk', code: 'FL-POLK' },
  { slug: 'brevard', name: 'Brevard', code: 'FL-BREVARD' },
  { slug: 'volusia', name: 'Volusia', code: 'FL-VOLUSIA' },
  { slug: 'sarasota', name: 'Sarasota', code: 'FL-SARASOTA' },
  { slug: 'manatee', name: 'Manatee', code: 'FL-MANATEE' },
  { slug: 'alachua', name: 'Alachua', code: 'FL-ALACHUA' },
  { slug: 'clay', name: 'Clay', code: 'FL-CLAY' },
  { slug: 'nassau', name: 'Nassau', code: 'FL-NASSAU' },
  { slug: 'flagler', name: 'Flagler', code: 'FL-FLAGLER' },
  { slug: 'putnam', name: 'Putnam', code: 'FL-PUTNAM' },
  { slug: 'marion', name: 'Marion', code: 'FL-MARION' },
];

export function findCounty(slug: string): VoterFocusCounty | undefined {
  const needle = slug.toLowerCase().replace(/[^a-z]/g, '');
  return VOTERFOCUS_COUNTIES.find((c) => c.slug === needle);
}

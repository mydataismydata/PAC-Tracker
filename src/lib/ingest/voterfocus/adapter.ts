/**
 * VoterFocus county adapter.
 *
 * Covers the county tier the Division of Elections does not hold: county
 * commission, school board, and the special districts (mosquito control,
 * airport authority, hospital, water management) that file locally.
 *
 * The county is a single query parameter, so this one adapter serves every
 * VoterFocus county — see `counties.ts`.
 */

import { VoterFocusClient } from './client';
import {
  parseEntityIndex,
  parseElections,
  parseTransactionExport,
  type VoterFocusEntity,
  type VoterFocusElection,
} from './parse';
import type { RawTransactionRow } from '../types';
import { findCounty, type VoterFocusCounty } from './counties';

export class VoterFocusAdapter {
  readonly sourceKey: string;
  readonly county: VoterFocusCounty;

  constructor(
    countySlug: string,
    private readonly client: VoterFocusClient = new VoterFocusClient(),
  ) {
    const county = findCounty(countySlug);
    if (!county) {
      throw new Error(
        `unknown VoterFocus county "${countySlug}". Add it to counties.ts once confirmed — ` +
          `an unrecognized slug returns an empty page rather than an error.`,
      );
    }
    this.county = county;
    this.sourceKey = `voterfocus-${county.slug}`;
  }

  /** Election cycles this county publishes. */
  async elections(): Promise<VoterFocusElection[]> {
    const html = await this.client.get(
      `candidate_pr.php?c=${this.county.slug}`,
      this.county.slug,
    );
    return parseElections(html);
  }

  /**
   * Candidates and committees for one election cycle.
   *
   * Omitting `electionId` uses whichever cycle the portal defaults to, which is
   * the current one.
   */
  async entities(electionId?: string): Promise<VoterFocusEntity[]> {
    const q = electionId
      ? `candidate_pr.php?c=${this.county.slug}&e=${electionId}`
      : `candidate_pr.php?c=${this.county.slug}`;
    return parseEntityIndex(await this.client.get(q, this.county.slug));
  }

  /**
   * Every itemized transaction for one candidate or committee.
   *
   * Uses the per-entity export rather than the site's transaction search: the
   * search is scoped to the session's selected election and returns an empty
   * result set more often than not, whereas the export is addressed by id and
   * returns contributions and expenditures together.
   */
  async transactionsFor(entity: VoterFocusEntity): Promise<RawTransactionRow[]> {
    const csv = await this.client.get(
      `export.php?op=CFINANCE&cand_id=${entity.candId}&dhc=0&county=${this.county.slug}`,
      this.county.slug,
    );
    const { rows } = parseTransactionExport(csv, {
      filerName: entity.name,
      filerOffice: entity.office,
      filerParty: entity.party,
      filerIsCommittee: entity.isCommittee,
      countySlug: this.county.slug,
    });
    return rows;
  }

  /**
   * Walk every entity in a cycle, yielding as each export completes so a long
   * county sweep can be persisted incrementally rather than buffered whole.
   */
  async *sweep(
    electionId?: string,
    onProgress?: (entity: VoterFocusEntity, rowCount: number, index: number, total: number) => void,
  ): AsyncGenerator<{ entity: VoterFocusEntity; rows: RawTransactionRow[] }> {
    const entities = await this.entities(electionId);
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      try {
        const rows = await this.transactionsFor(entity);
        onProgress?.(entity, rows.length, i + 1, entities.length);
        yield { entity, rows };
      } catch (err) {
        // One unreadable filer must not abort a sweep of hundreds.
        onProgress?.(entity, -1, i + 1, entities.length);
        console.warn(`  ! ${entity.name}: ${String(err).slice(0, 80)}`);
      }
    }
  }
}

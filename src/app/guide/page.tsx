/**
 * How the app works, written for someone who has it open in the next tab.
 *
 * Every control on the screen is named here with its default and its range, so
 * a reader can match what they are looking at to what it does. The source table
 * is queried rather than typed out, because a hand-written count is wrong the
 * first time anyone runs an ingest.
 */

import type { Metadata } from 'next';
import { loadedStats } from '@/lib/sources';
import { formatMoneyFull } from '@/lib/graph/types';
import { CURRENT_CYCLE, PREVIOUS_CYCLE } from '@/lib/cycles';

/**
 * Rendered per request, never prerendered: the Docker builder stage has no
 * database, so a static build would try to count three million rows with no
 * connection and fail the image build. `loadedStats` memoises for an hour, so
 * the page is dynamic without paying for the query every time.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Guide — PAC Tracker',
  description: 'What every control does, how the panel works, and what is loaded.',
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 border-b border-slate-800 pb-2 text-lg font-semibold text-slate-100">
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 text-sm font-semibold text-indigo-300">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-slate-300">{children}</p>;
}

/** A control's name, its default, and what it does. */
function Setting({
  name,
  meta,
  children,
}: {
  name: string;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 border-l-2 border-slate-800 pl-4">
      <p className="text-sm font-medium text-slate-100">
        {name} <span className="font-normal text-slate-500">{meta}</span>
      </p>
      <div className="mt-1 text-sm leading-relaxed text-slate-400">{children}</div>
    </div>
  );
}

function Swatch({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-sm border"
        style={{ borderColor: color, backgroundColor: `${color}28` }}
      />
      <span>{children}</span>
    </li>
  );
}

export default async function GuidePage() {
  const { sources, kinds } = await loadedStats();
  const totalTxns = sources.reduce((a, s) => a + s.txns, 0);
  const totalEntities = kinds.reduce((a, k) => a + k.count, 0);

  return (
    // The root layout pins the body to the viewport, because the graph owns its
    // own scrolling. This is an ordinary document and has to scroll itself.
    <div className="h-dvh overflow-y-auto bg-slate-950">
      <main className="mx-auto max-w-3xl px-5 py-10 text-slate-100">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
          PAC Tracker
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">User guide</h1>

        <P>
          PAC Tracker draws Florida political money as a graph. You pick a starting entity, and
          the app walks outward along recorded payments and draws what it finds. Every figure on
          the screen comes from a filed report, and every row links to the party it names.
        </P>
        <P>
          The database currently holds {totalTxns.toLocaleString()} transactions across{' '}
          {totalEntities.toLocaleString()} entities. The full list of what is loaded, and where it
          came from, is at the bottom of this page.
        </P>

        {/* ---------------------------------------------------------- start */}
        <H2>Choosing where to start</H2>
        <P>
          The search box sits in the header. Type at least two characters; it queries after a
          220ms pause and returns up to 15 matches. Each result shows the entity kind and its
          totals for the cycle you have selected, so the numbers in the dropdown are the numbers
          you get on the canvas. Arrow keys move through the list and Enter picks one.
        </P>
        <P>
          Choosing a result makes that entity the seed and starts a crawl. Nothing is drawn until
          you pick one.
        </P>

        {/* ------------------------------------------------------- controls */}
        <H2>Controls</H2>
        <P>
          The left sidebar has two tabs, Controls and Saved searches. Controls holds eight
          settings. Changing any of them re-runs the crawl from the same seed.
        </P>

        <Setting name="Depth" meta="1 to 6, default 2">
          How many hops out from the seed to walk. Depth 1 draws only what touches the seed
          directly. The crawl fetches one level at a time and streams tiles in as they arrive, so
          the header counts up through &quot;level 2…&quot; while it runs.
        </Setting>

        <Setting name="Election cycle" meta={`default Current (${CURRENT_CYCLE.label})`}>
          Florida files a whole cycle under its general-election id, so a contribution dated 2023
          for the {CURRENT_CYCLE.label} election is a {CURRENT_CYCLE.label} row. Three buttons
          cover Current ({CURRENT_CYCLE.label}), Previous ({PREVIOUS_CYCLE.label}) and All; the
          dropdown below them reaches every cycle back to 2000. All is offered but is not the
          default, because an unfiltered graph quietly answers &quot;who has ever funded this&quot;,
          which is rarely the question being asked.
        </Setting>

        <Setting name="Direction" meta="default Both">
          Up follows money into the entity. Down follows money out of it. Both does each.
        </Setting>

        <Setting name="Link mode" meta="default Direct links only">
          <p>What counts as a connection worth following:</p>
          <ul className="mt-2 space-y-2">
            <li>
              <span className="text-slate-200">Direct links only</span> follows the
              committee-to-committee chain and leaves individual and corporate donors out, which
              keeps the political money path readable.
            </li>
            <li>
              <span className="text-slate-200">Include donor links</span> also pulls in the donors
              feeding each committee reached. That is the full funding base and a much larger
              graph.
            </li>
            <li>
              <span className="text-slate-200">Registration links</span> hops on shared officers
              instead of money: every committee naming the same chair or treasurer. It reaches
              committees with no payment between them, then draws the money that does move inside
              that network. Dashed lines in this mode are paperwork, not payments.
            </li>
          </ul>
          <p className="mt-2">
            Switching to Registration raises Max per node from 25 to 200, and switching away
            lowers it again. The cap means different things in each mode: on money it trims a tail
            of small donors, but on registration every hop is a co-registered committee, so 25
            would show a quarter of a network and look complete. One Tallahassee treasurer is
            named on 103 committees. The retuned value is written into the visible field rather
            than applied behind your back, so you can see it and override it.
          </p>
        </Setting>

        <Setting name="Min $ per edge" meta="default any">
          Drops any connection below the amount you type. Useful for pulling the shape of a large
          graph out from under a mass of small contributions.
        </Setting>

        <Setting name="Max per node" meta="1 to 200, default 25">
          How many connections to follow out of each entity reached. Connections are taken largest
          first, so raising this adds smaller money rather than different money.
        </Setting>

        <Setting name="From date / To date" meta="default unset">
          Restricts the crawl to transactions dated inside the window. This is the transaction
          date, which is not the same filter as the cycle: a 2026-cycle contribution can be dated
          2023.
        </Setting>

        <Setting name="Node ceiling" meta="50 to 3000, default 600">
          A hard stop on graph size. When a crawl hits it, an amber
          &quot;capped at N nodes&quot; badge appears in the header, so a truncated graph is never
          presented as a complete one.
        </Setting>

        {/* --------------------------------------------------------- canvas */}
        <H2>Reading the canvas</H2>
        <P>Colour is the entity kind. The same key sits at the bottom right of the graph.</P>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
          <Swatch color="#6366f1">Committee or PAC</Swatch>
          <Swatch color="#10b981">Candidate</Swatch>
          <Swatch color="#f59e0b">Organization</Swatch>
          <Swatch color="#64748b">Individual</Swatch>
        </ul>

        <H3>Tiles</H3>
        <P>
          Each tile carries the entity name on the first line and its money on the second. The
          seed is drawn wider, with a heavier border. A dashed border means the entity has
          connections the crawl did not draw, so there is more behind it if you re-center there or
          raise the depth. A selected tile gets an amber border.
        </P>
        <P>
          Officer tiles are round rather than rectangular, drawn in violet with a dashed outline.
          They stand for a person named on committee paperwork rather than an entity that receives
          money, which is why they cannot be re-centered on.
        </P>

        <H3>Lines</H3>
        <P>
          Thickness is scaled logarithmically against the largest connection currently on screen,
          so the top donor does not render everything below it as a hairline. The label is the
          amount. Registration links are drawn dashed at a fixed hairline width and labelled with
          the shared role instead of a figure, because a registration line labelled &quot;$0&quot;
          would read as a payment of nothing.
        </P>

        <H3>Moving around</H3>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
          <li>
            <span className="text-slate-100">Click a tile</span> to select it. Everything except
            that tile and the ones it trades with is dimmed, and the Details panel fills.
          </li>
          <li>
            <span className="text-slate-100">Double-click a tile</span> to re-root the crawl
            there.
          </li>
          <li>
            <span className="text-slate-100">Drag a tile</span> to pin it. Later layout passes
            leave it where you put it.
          </li>
          <li>
            <span className="text-slate-100">Click empty space</span> to clear the selection and
            undim.
          </li>
          <li>
            <span className="text-slate-100">Arrow keys</span> pan. The + and − buttons at the
            bottom left zoom, as does a wheel or trackpad.
          </li>
        </ul>

        {/* ---------------------------------------------------------- header */}
        <H2>Header buttons</H2>
        <P>
          While a crawl runs the header shows the level it is on. When it finishes it shows the
          node count, the edge count, the total money drawn and how long the crawl took.
        </P>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
          <li>
            <span className="text-slate-100">Fit</span> zooms to put the whole graph on screen.
          </li>
          <li>
            <span className="text-slate-100">Full screen</span> hands the page to the browser.
            Escape leaves.
          </li>
          <li>
            <span className="text-slate-100">Save PNG</span> writes the current canvas to an image
            named after the seed.
          </li>
          <li>
            <span className="text-slate-100">Account</span> changes your password or signs you
            out. Changing a password ends every other session on that account.
          </li>
        </ul>

        {/* ---------------------------------------------------------- detail */}
        <H2>The Details panel</H2>
        <P>
          The right pane fills when you select an entity. On a phone it is the Detail tab at the
          bottom of the screen.
        </P>
        <P>
          The top of the panel names the entity, its kind, the office it seeks, its city, and
          whether the committee is closed. Under that, its officers. Each officer name opens that
          person along with everything their committees raised. The ×N beside a name counts the
          committees they appear on; names on 25 or more are greyed out, since a treasurer of
          record on 100 committees says little about any one of them.
        </P>
        <P>
          The Received and Given tiles are buttons. Clicking one filters the list below to that
          direction. Received counts distinct sources, Given counts recipients. Re-center crawl
          here re-roots the graph on this entity; it is absent for officers, who are not crawlable
          entities.
        </P>

        <H3>The three tabs</H3>
        <Setting name="By party" meta="one row per counterparty">
          Aggregated. Each row gives a counterparty, its total, how many transactions make it up,
          and the most recent date. Sorted largest first by default.
        </Setting>
        <Setting name="Every transaction" meta="one row per filed line item">
          Each row gives the date, the transaction type code, the contributor occupation and the
          mailing address as filed. Sorted newest first by default.
        </Setting>
        <Setting name="Funding origins" meta="described in the next section">
          Follows the money past committee-to-committee transfers to whoever originated it.
        </Setting>

        <H3>Filtering and export</H3>
        <P>
          Money in, Money out and Both set the direction. The text box filters by counterparty
          name. The sort offers Largest first, Most recent and Name A to Z, plus Most transactions
          on the By party tab. Switching tabs resets the sort to that tab&apos;s default, and a
          sort you pick by hand survives until you change tabs again.
        </P>
        <P>
          Rows load 100 at a time, with a button for the next 100. Above the list, a count and a
          total that reconcile against the tiles at the top of the panel. When money moved between
          committees inside the group you are looking at, an amber line names the amount: it is
          real money, but it neither entered nor left the network, so a headline that includes it
          overstates what was raised.
        </P>
        <P>
          Export CSV writes the current tab for the current filters. Every row in every tab links
          to the party it names, including individual transactions, and a dot marks the parties
          already drawn on the canvas.
        </P>

        {/* --------------------------------------------------------- origins */}
        <H2>How Funding origins finds its data</H2>
        <P>
          A committee&apos;s donor list is not its funding. Where the donors are themselves
          committees, which is the norm for the transfer layer, the list only names the next
          committees to go read. Funding origins follows that chain and attributes the seed
          money back to the entities that put it in.
        </P>

        <H3>What counts as a conduit</H3>
        <P>
          Committees and parties pass money through. Everything else originates it: organizations,
          individuals and candidates end a strand, and the money stops there and is credited to
          them.
        </P>

        <H3>How the money is divided</H3>
        <P>
          Attribution is pro-rata, because money in an account is fungible. A conduit that took
          $1M and passed on $100k passed on 10% of each of its own sources. That is a claim about
          proportions of a pool, not about the route a particular dollar took, and the panel says
          so under the bars.
        </P>

        <H3>How far it walks</H3>
        <P>
          Breadth-first, one level at a time, to a limit of 12 hops. A strand worth less than $100
          is dropped into the long tail rather than chased further. Loops in the graph need no
          special handling: money is absorbed at every non-conduit, so a strand decays on each
          pass instead of circling forever.
        </P>

        <H3>Date ordering</H3>
        <P>
          The checkbox reading &quot;Only credit money a conduit held before it paid out&quot; is
          on by default. Each hop then tightens a cutoff date, and a source is credited only if
          its contribution arrived on or before the day of the transfer it is supposed to have
          funded. Same-day counts, since a transfer can be funded by money banked that day. Turn
          it off and a source can be credited for a transfer that predates its own contribution.
        </P>

        <H3>The four bars</H3>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
          <li>
            <span className="text-emerald-400">Traced</span> is money attributed to an originating
            entity.
          </li>
          <li>
            <span className="text-sky-400">National pool</span> is money that entered Florida
            through a committee whose own funding is disclosed to the IRS rather than to Florida.
          </li>
          <li>
            <span className="text-slate-400">Unresolved</span> is money sitting at a committee
            with no recorded upstream, or still moving when the 12-hop limit ran out. These are
            listed under &quot;Trail ends here&quot;.
          </li>
          <li>
            <span className="text-slate-500">Long tail</span> is strands abandoned below $100,
            plus anything dropped at the 4,000-strand ceiling. When that ceiling is reached, the
            panel says so rather than letting the bars quietly fail to add up.
          </li>
        </ul>

        <H3>Why national pools sit apart</H3>
        <P>
          One entity is currently marked as a national pool: the Republican State Leadership
          Committee, which files IRS Form 8872 rather than reporting to Florida. Its own largest
          funders are listed beneath it, up to 12 of them, as shares of that pool rather than of
          your seed. The two figures cannot be multiplied together, because no filing states what
          share of the pool came to Florida. Keeping the money in its own bar is what stops that
          multiplication from looking reasonable.
        </P>

        {/* --------------------------------------------------------- saved */}
        <H2>Saved searches</H2>
        <P>
          The second sidebar tab saves the current seed, every control setting and the positions
          you dragged tiles into, under a name you choose. Loading one restores all three, so a
          graph you arranged by hand comes back arranged. Saving needs a seed picked first.
        </P>

        {/* --------------------------------------------------------- person */}
        <H2>Person pages</H2>
        <P>
          A person page is a plain summary at a stable address, and it is the one part of the app
          that needs no sign-in. Florida splits a politician across a campaign account per office
          sought plus any affiliated committees, so these pages merge the filings and show the
          combined total, the filings that make it up, and the largest 100 donors and 100 payments
          out. Each filing links into the graph seeded on it.
        </P>

        {/* -------------------------------------------------------- sources */}
        <H2>What is loaded</H2>
        <P>
          {sources.length} sources, {totalTxns.toLocaleString()} transactions. Counts are read
          from the database rather than written into this page, so they track what an ingest
          actually wrote.
        </P>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 font-medium">Source</th>
                <th className="py-2 pr-3 font-medium">Covers</th>
                <th className="py-2 pr-3 text-right font-medium">Transactions</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900">
              {sources.map((s) => (
                <tr key={s.key} className="align-top">
                  <td className="py-3 pr-3">
                    <span className="block text-slate-200">{s.name}</span>
                    {s.url && (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 block break-all text-[11px] text-indigo-400 hover:underline"
                      >
                        {s.url}
                      </a>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-slate-400">
                    <span className="block">{s.jurisdiction ?? 'unattributed'}</span>
                    {s.earliest && (
                      <span className="mt-0.5 block text-[11px] tabular-nums text-slate-500">
                        {s.earliest} to {s.latest}
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-slate-300">
                    {s.txns.toLocaleString()}
                  </td>
                  <td className="py-3 text-right tabular-nums text-emerald-400">
                    {formatMoneyFull(s.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <H3>Entities</H3>
        <ul className="mt-3 space-y-1 text-sm text-slate-300">
          {kinds.map((k) => (
            <li key={k.kind} className="flex justify-between border-b border-slate-900 py-1">
              <span className="capitalize">{k.kind}</span>
              <span className="tabular-nums text-slate-400">{k.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>

        {/* --------------------------------------------------------- limits */}
        <H2>Where the numbers stop being exact</H2>
        <P>
          The Florida feed states the cycle a transaction belongs to. The two county portals and
          the IRS filings do not: county portals have no cycle field at all, and 8872 rows carry a
          filing period that would split one national committee across four cycles nobody would
          think to select. Both fall back to the cycle their date lands in, which puts a filing
          made late in one cycle for the next election in the wrong bucket.
        </P>
        <P>
          A crawl that hits the node ceiling or the per-node cap says so in the header. Funding
          origins reports its long tail and its unresolved money as their own bars for the same
          reason: the parts that did not resolve are visible instead of folded into the parts that
          did.
        </P>

        <p className="mt-12 border-t border-slate-800 pt-4 text-xs text-slate-600">
          Every figure traces to a filed report. Where this app infers something the filings do
          not state, the panel that shows it says so.
        </p>
      </main>
    </div>
  );
}

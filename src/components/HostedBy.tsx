/**
 * Who hosts the site, set under the title on every page.
 *
 * One component, so the wording and the address live in one place. It is set in
 * the same small grey capitals as the "Powered by" line in the Know Your Mailer
 * masthead, so it reads as a credit rather than as a second heading. The
 * caucus's name links to its site behind a faint underline that only brightens
 * on hover or focus.
 *
 * Balanced, so a narrow column breaks it into two even lines instead of
 * leaving the last word on a line of its own.
 *
 * `short` abbreviates the name to "St. Johns County RLC" so the credit keeps
 * to one line, and keeps the full name in the link's tooltip. `tight` sets it
 * a size smaller, for the explorer's header, where any extra width pushes the
 * search box off its row.
 */

const HOST_NAME = 'St. Johns County Republican Liberty Caucus';
const HOST_URL = 'https://sjcrlc.org';

export default function HostedBy({
  className = '',
  short = false,
  tight = false,
}: {
  className?: string;
  short?: boolean;
  tight?: boolean;
}) {
  const size = tight ? 'text-[10px] tracking-[0.12em]' : 'text-[11px] tracking-[0.14em]';
  return (
    <p className={`text-balance font-mono uppercase text-slate-500 ${size} ${className}`}>
      Hosted by {short ? '' : 'the '}
      <a
        href={HOST_URL}
        title={short ? HOST_NAME : undefined}
        className="underline decoration-slate-700 underline-offset-2 transition-colors
                   hover:text-slate-300 hover:decoration-slate-400
                   focus-visible:text-slate-300 focus-visible:decoration-slate-400
                   focus-visible:outline-none"
      >
        {short ? 'St. Johns County RLC' : HOST_NAME}
      </a>
    </p>
  );
}

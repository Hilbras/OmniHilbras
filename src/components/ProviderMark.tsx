import { needsDarkTile, needsLightTile } from '../lib/logoPolarity.generated';

type ProviderMarkProps = {
  logo?: string;
  initial: string;
  color: string;
  className?: string;
};

/**
 * The tile a logo sits on, when the tile has to be the opposite of the logo.
 *
 * Fixed rather than themed, deliberately. A logo tile is small and always sits on a card, and
 * the point of the tile is to give the mark contrast — so the tile follows the *mark*, not the
 * page. Deriving it from the theme instead is what produced a white glyph on a white tile in
 * light mode and a black glyph on a black tile in dark mode: the same asset, invisible in
 * whichever theme it did not match.
 */
const DARK_TILE = '#15130e';
const LIGHT_TILE = '#ffffff';

export function ProviderMark({ logo, initial, color, className = 'rounded-xl' }: ProviderMarkProps) {
  // `logo` is a `/providers/<file>.svg` path, and the polarity index is keyed by file name.
  const file = logo?.split('/').pop() ?? '';
  const backgroundColor = !logo
    ? `${color}14`
    : needsDarkTile(file)
      ? DARK_TILE
      : needsLightTile(file)
        ? LIGHT_TILE
        : undefined;

  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden border text-xs font-bold ${className}`}
      style={{
        borderColor: `${color}35`,
        // Undefined lets the card's own surface through for the marks that are neither white
        // nor black — the multi-coloured brand logos, which suit either background.
        ...(backgroundColor ? { backgroundColor } : {}),
        color,
      }}
    >
      {logo ? <img src={logo} alt="" className="h-[68%] w-[68%] object-contain" draggable={false} /> : initial}
    </span>
  );
}

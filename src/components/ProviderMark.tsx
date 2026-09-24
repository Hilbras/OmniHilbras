type ProviderMarkProps = {
  logo?: string;
  initial: string;
  color: string;
  className?: string;
};

export function ProviderMark({ logo, initial, color, className = 'rounded-xl' }: ProviderMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden border text-xs font-bold ${className}`}
      style={{ borderColor: `${color}35`, backgroundColor: logo ? '#ffffff' : `${color}14`, color }}
    >
      {logo ? <img src={logo} alt="" className="h-[68%] w-[68%] object-contain" draggable={false} /> : initial}
    </span>
  );
}

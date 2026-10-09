import Image from 'next/image';
import './brand.css';

export function Brand() {
  return (
    <span className="jcl-brand">
      <Image
        src="/brand/jcl-logo.jpg"
        alt=""
        width={72}
        height={72}
        className="jcl-brand-logo"
        priority
      />
      <span className="jcl-brand-name">
        Judo Child<span>League</span>
      </span>
    </span>
  );
}

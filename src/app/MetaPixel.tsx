'use client';
import Script from 'next/script';
import { useEffect } from 'react';
import { pixelPageView } from './pixel';

/** Meta's base code. Its own history tracking is off: the game sends PageView itself when it moves to another puzzle. */
export default function MetaPixel({ id }: { id: string }) {
  // back/forward between puzzles is a navigation too
  useEffect(() => {
    addEventListener('popstate', pixelPageView);
    return () => removeEventListener('popstate', pixelPageView);
  }, []);
  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq.disablePushState=true;
fbq('init','${id}');
fbq('track','PageView');`}
    </Script>
  );
}

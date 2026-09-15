import { useEffect, useState } from 'react';

/** Hash routes, so the operator console needs no router dependency or server rewrites. */
export type Route =
  | { view: 'overview' }
  | { view: 'campaign'; campaignId: string }
  | { view: 'conversations'; leadId: string | null; campaignId: string | null }
  | { view: 'reviews' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [section, id] = path.split('/');
  const hasId = id !== undefined && id !== '';
  switch (section) {
    case 'campaigns':
      return hasId ? { view: 'campaign', campaignId: id } : { view: 'overview' };
    case 'conversations':
      return {
        view: 'conversations',
        leadId: hasId ? id : null,
        campaignId: new URLSearchParams(query).get('campaign'),
      };
    case 'reviews':
      return { view: 'reviews' };
    default:
      return { view: 'overview' };
  }
}

export function conversationHref(leadId: string, campaignId: string | null = null): string {
  return `#/conversations/${leadId}${campaignId === null ? '' : `?campaign=${campaignId}`}`;
}

export function useHashRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return parseRoute(hash);
}

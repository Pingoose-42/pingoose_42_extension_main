#!/usr/bin/python3
"""Fetch a bounded public site icon without accessing Intra's browser session."""
import hashlib, ipaddress, socket, sys, urllib.request, urllib.parse
from html.parser import HTMLParser
from pathlib import Path
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

def public_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('HTTPS public URL required')
    for address in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM):
        if not ipaddress.ip_address(address[4][0]).is_global:
            raise ValueError('Non-public address')
    return url

class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return super().redirect_request(request, fp, code, msg, headers, public_url(newurl))

socket.setdefaulttimeout(5)
opener = urllib.request.build_opener(Redirect)
def fetch(url, limit):
    req = urllib.request.Request(public_url(url), headers={'User-Agent':'Pingoose/1.0 (site preview)'})
    with opener.open(req, timeout=5) as response:
        data = response.read(limit + 1)
        if len(data) > limit: raise ValueError('Oversized preview')
        return data, response.url

class Metadata(HTMLParser):
    def __init__(self): super().__init__(); self.images=[]; self.icons=[]
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if tag=='meta' and attrs.get('property',attrs.get('name','')).lower() in ('og:image','twitter:image'):
            self.images.append(attrs.get('content',''))
        if tag=='link' and 'icon' in attrs.get('rel','').lower(): self.icons.append(attrs.get('href',''))

def main():
    url, directory = sys.argv[1:3]
    target = Path(directory) / (hashlib.sha256(url.encode()).hexdigest()+'.png')
    if target.exists(): print(target); return
    candidates=[]
    try:
        data, resolved=fetch(url, 512000)
        parser=Metadata(); parser.feed(data.decode('utf-8',errors='replace'))
        candidates=[urllib.parse.urljoin(resolved,item) for item in parser.icons if item]
    except Exception: pass
    candidates.append(urllib.parse.urljoin(url,'/favicon.ico'))
    for candidate in candidates[:4]:
        try:
            data,_=fetch(candidate, 1500000)
            loader=GdkPixbuf.PixbufLoader()
            loader.connect('size-prepared',lambda obj,w,h: obj.set_size(max(1,round(w*min(64/w,64/h))),max(1,round(h*min(64/w,64/h)))))
            loader.write(data); loader.close()
            pix=loader.get_pixbuf()
            if not pix: continue
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            pix.savev(str(target),'png',[],[])
            target.chmod(0o600)
            print(target); return
        except Exception: continue
    sys.exit(1)
if __name__=='__main__': main()

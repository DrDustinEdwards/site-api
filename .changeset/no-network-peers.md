---
"@dustinedwards/site-api": patch
---

site-runtime and Prelum (`@drdustinedwards/site-helpers`) are no longer peer dependencies. Neither is on the npm
registry, so npm cannot resolve a peer range for them: whenever a site's lockfile update moved site-api together with
site-runtime or Prelum (Renovate's "network packages" update), `npm install` failed with ERESOLVE and every such update
stayed red. A site still installs both beside site-api (site-runtime 0.143.0 or later, Prelum 0.49.0 or later), which
every site already does, so there is still one copy of each; devkit-shared's pin check keeps them current. The exact
tags stay as devDependencies for site-api's own tests.

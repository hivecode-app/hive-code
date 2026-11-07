# Landing page

One static page for Hive Code, published with GitHub Pages. It uses the app's visual language (`packages/app/lib/theme/tokens.dart`), its fonts (`packages/app/assets/fonts/`), the logo in `docs/brand/hive-code/` and the README screenshots in `docs/assets/screenshots/`. Those are copied at build time and not kept here, so the page always shows the current app and brand.

```sh
site/build.sh            # builds into site/_site
python3 -m http.server -d site/_site 8000
```

Links on the page are relative, so it works at any address. The one exception is `og:image` in `index.html`, which social networks need as a full URL. It points at `https://hivecode-app.github.io/hive-code/`, where the workflow in the `hive-code` repository publishes: change it if the page moves to a custom domain.

Publishing is manual: run the **Pages** workflow (`.github/workflows/pages.yml`) from the Actions tab. Nothing publishes on push.

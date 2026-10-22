const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { expandHtmlIncludes } = require('./scripts/includeHtmlPartials.js');
const { injectPageMeta, injectSeoHead } = require('./scripts/injectPageMetaIntoHtml.js');
const { injectApiBaseMeta } = require('./scripts/injectApiBaseMeta.js');
const { GenAttributeDemoManifestPlugin } = require('./scripts/genAttributeDemoManifestPlugin.js');

const SRC_ROOT = __dirname;
const WEB_DIST = process.env.INFORADAR_WEB_DIST || 'dist';
const WEB_DIST_ABS = path.resolve(__dirname, '..', WEB_DIST);

const PAGE_META_DOC = JSON.parse(
    fs.readFileSync(path.join(SRC_ROOT, 'assets', 'content', 'page-meta.json'), 'utf8')
);
const BUILD_TIME = new Date().toISOString();

function copyHtmlWithIncludesAndPageMeta(from, to, pageKey) {
    return {
        from,
        to,
        transform(content) {
            const expanded = expandHtmlIncludes(content.toString('utf8'), SRC_ROOT);
            let html = injectPageMeta(expanded, pageKey, PAGE_META_DOC);
            html = injectApiBaseMeta(html);
            return html;
        },
    };
}

function copyHtmlWithIncludesAndStaticSeo(file) {
    const seoMeta = PAGE_META_DOC.staticPages && PAGE_META_DOC.staticPages[file];
    if (!seoMeta) {
        throw new Error(`webpack: missing staticPages SEO meta for ${file}`);
    }
    return {
        from: file,
        to: file,
        transform(content) {
            const expanded = expandHtmlIncludes(content.toString('utf8'), SRC_ROOT);
            let html = injectSeoHead(expanded, seoMeta, PAGE_META_DOC);
            html = injectApiBaseMeta(html);
            return html;
        },
    };
}

module.exports = {
    entry: {
        home: './pages/home/index.ts',
        analysis: './pages/analysis/index.ts',
        compare: './pages/compare/index.ts',
        chat: './pages/chat/index.ts',
        attribution: './pages/attribution/index.ts',
        causal_flow: './pages/causal_flow/index.ts',
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        transpileOnly: true // Faster compilation, type checking done by ForkTsCheckerWebpackPlugin
                    }
                }
            },
            {
                test: /\.s?css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    {
                        loader: 'css-loader',
                        options: {
                            sourceMap: true
                        }
                    },
                    {
                        loader: 'sass-loader',
                        options: {
                            sourceMap: true,
                            api: 'modern',
                            sassOptions: {
                                loadPaths: [
                                    path.join(__dirname, 'css/base'),
                                    path.join(__dirname, 'css/components'),
                                    path.join(__dirname, 'css/pages'),
                                ],
                            },
                        }
                    }
                ]
            },
            {
                test: /\.(png|jpg)$/,
                type: 'asset',
                parser: {
                    dataUrlCondition: {
                        maxSize: 20000 // inline <= 20kb
                    }
                }
            },
            {
                test: /\.mov$/,
                type: 'asset/resource'
            },
            {
                test: /\.mp3$/,
                type: 'asset/resource'
            },
            {
                test: /\.woff(2)?(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                type: 'asset',
                parser: {
                    dataUrlCondition: {
                        maxSize: 20000 // inline <= 20kb
                    }
                },
                generator: {
                    dataUrl: {
                        mimetype: 'application/font-woff'
                    }
                }
            },
            {
                test: /\.svg(2)?(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                type: 'asset',
                parser: {
                    dataUrlCondition: {
                        maxSize: 10000 // inline <= 10kb
                    }
                },
                generator: {
                    dataUrl: {
                        mimetype: 'image/svg+xml'
                    }
                }
            },
            {
                test: /\.(ttf|eot)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                type: 'asset/resource'
            },
            {
            test: /\.html$/,
            exclude: /index\.html|analysis\.html|compare\.html|chat\.html|attribution\.html|causal_flow\.html/,
            type: 'asset/source'
            }
        ]
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    plugins: [
        new webpack.DefinePlugin({
            __BUILD_TIME__: JSON.stringify(BUILD_TIME),
        }),
        new MiniCssExtractPlugin({
            // Options similar to the same options in webpackOptions.output
            // both options are optional
            // filename: "style.css",
            // chunkFilename: "chunk.css"
        }),
        new ForkTsCheckerWebpackPlugin({
            typescript: {
                diagnosticOptions: {
                    semantic: true,
                    syntactic: true,
                },
                memoryLimit: 4096 // Increase memory limit
            },
        }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: 'assets/demos/causal_flow',
                    to: 'assets/demos/causal_flow',
                    context: path.join(__dirname),
                    filter: (resourcePath) => /\.json$/i.test(resourcePath),
                    noErrorOnMissing: true,
                },
                // Demo JSON files now live under data/demo and are served by the backend,
                // so we only need to copy the HTML shell into the dist folder.
                copyHtmlWithIncludesAndPageMeta('index.html', 'index.html', 'home'),
                copyHtmlWithIncludesAndPageMeta('analysis.html', 'analysis.html', 'infoHighlight'),
                copyHtmlWithIncludesAndStaticSeo('compare.html'),
                copyHtmlWithIncludesAndPageMeta('chat.html', 'chat.html', 'chat'),
                copyHtmlWithIncludesAndPageMeta('attribution.html', 'attribution.html', 'attribution'),
                copyHtmlWithIncludesAndPageMeta('causal_flow.html', 'causal_flow.html', 'causalFlow'),
                copyHtmlWithIncludesAndStaticSeo('privacy-policy.html'),
                copyHtmlWithIncludesAndStaticSeo('privacy-policy-info-highlight.html'),
                copyHtmlWithIncludesAndStaticSeo('info-highlight.html'),
                copyHtmlWithIncludesAndStaticSeo('info-highlight-terms.html'),
                copyHtmlWithIncludesAndStaticSeo('info-highlight-privacy.html'),
                copyHtmlWithIncludesAndStaticSeo('info-highlight-preview.html'),
                copyHtmlWithIncludesAndStaticSeo('uninstall.html'),
                copyHtmlWithIncludesAndStaticSeo('library.html'),
                { from: '_routes.json', to: '_routes.json' },
                { from: 'robots.txt', to: 'robots.txt' },
                { from: 'sitemap.xml', to: 'sitemap.xml' },
                { from: '404.html', to: '404.html' },
            ]
        }),
        new GenAttributeDemoManifestPlugin(),
    ],
    optimization: {
        splitChunks: {
            cacheGroups: {
                vendor: {
                    test: /node_modules/,
                    chunks: "initial",
                    name: "vendor",
                    priority: 10,
                    enforce: true
                }
            }
        }
    },
    output: {
        filename: '[name].js',
        path: WEB_DIST_ABS,
        clean: true // Clean output directory before emit
    },
    performance: {
        hints: false, // Disable performance hints
        maxEntrypointSize: 512000, // 500KB
        maxAssetSize: 512000 // 500KB
    },
    devServer: {
        port: 8090,
        proxy: {
            '/api': {
                target: 'http://localhost:5001',
                secure: false,
                ws: true
            },
            '/v1': {
                target: 'http://localhost:5001',
                secure: false
            }
        }
    }
};

const fs = require('fs');
const parseFrontMatter = require('gray-matter');
const unified = require('unified');
const rehypeParse = require('rehype-parse');
const rehypeStringify = require('rehype-stringify');
const link = require('rehype-autolink-headings');
const remarkHtml = require('remark-html');
const remarkParse = require('remark-parse');
const remarkSlug = require('remark-slug');
const remarkExternalLinks = require('remark-external-links');
const remarkAutolinkHeadings = require('remark-autolink-headings');
const kumaMacros = require('./kuma');

const walk = require('./src/utils/walk');
const findHeadings = require('./src/utils/find-headings');
const matchMacro = /\{\{(\w+)(?:\(([^{]+)\))?\}\}/g;
const matchArgument = /(?:"([^"]+)")|(?:'([^']+)')|(\d+)|(''|"")/g;
const parseArgs = (argumentString) => {
  return [...argumentString.matchAll(matchArgument)].map(
    ([, str1, str2, num, emptyStr]) => {
      if (str1 || str2) {
        return str1 || str2;
      } else if (num) {
        return parseInt(num);
      } else if (emptyStr) {
        return '';
      }
      return undefined;
    }
  );
};
const hasSidebar = ([name]) => {
  const functionNames = {
    CSSRef: 'CSSRef',
    JsSidebar: 'JsSidebar',
    jsSidebar: 'JsSidebar',
    JSRef: 'JSRef',
  };
  return functionNames[name];
};

// Prepare HTML parser with necessary plugins
const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(link) // Wrap headings in links, so they became inteactive
  .use(rehypeStringify);

const markdownProcessor = unified()
  .use(remarkParse)
  .use([
    remarkSlug,
    [
      remarkExternalLinks,
      {
        target: '_blank',
        rel: ['noopener', 'noreferrer'],
      },
    ],
    [
      remarkAutolinkHeadings,
      {
        content: {
          type: 'element',
          tagName: 'span',
          properties: {
            className: 'icon icon-link',
          },
        },
        linkProperties: {
          'aria-hidden': 'true',
        },
      },
    ],
  ])
  .use(remarkHtml);

const runMacros = (content) => {
  let resultContent = content;
  const recognizedMacros = [...content.matchAll(matchMacro)];
  const data = {};

  recognizedMacros.map((expression) => {
    const [match, functionName, args] = expression;
    let result = match; // uninterpolated macros will be visible by default
    if (kumaMacros[functionName]) {
      if (args) {
        result = kumaMacros[functionName](...parseArgs(args));
      } else {
        result = kumaMacros[functionName]();
      }
    }
    if (result !== match) {
      // don't spend processor cycles on replacing the same strings
      resultContent = resultContent.replace(match, result);
    }

    // add additional data for nav components
    const sidebarType = hasSidebar([functionName, args]);
    if (sidebarType) {
      data.hasSidebar = sidebarType;
    }
  });

  return {
    content: resultContent,
    data,
  };
};

// Server API makes it possible to hook into various parts of Gridsome
// on server-side and add custom data to the GraphQL data layer.
// Learn more: https://gridsome.org/docs/server-api/

// Changes here require a server restart.
// To restart press CTRL + C in terminal and run `gridsome develop`

module.exports = function (api) {
  api.loadSource(async ({ addCollection, addMetadata }) => {
    // Use the Data Store API here: https://gridsome.org/docs/data-store-api/
    addMetadata('settings', require('./gridsome.config').settings);

    const mdnContentPath = '../webdoky-content/original-content/files'; // TODO: move this into config?
    const locale = 'en-US';
    const mdnContentFilenames = await walk(mdnContentPath); // TODO: move this to a custom transformer

    const collection = addCollection({
      typeName: 'MdnPage',
    });

    const addNodeToCollection = ({ content, headings, data, path }) => {
      const { content: processedContent, data: processedData } =
        runMacros(content);

      collection.addNode({
        content: processedContent,
        headings,
        ...data,
        path,
        ...processedData,
      });
    };

    // TODO move this into a custom transformer or smth
    const htmlPages = mdnContentFilenames
      .filter((path) => /\.html/.test(path)) // TODO: we'll need images here
      .filter((path) => !/\(/.test(path)) // TODO: fix vue router giving me an error on such paths
      .map(async (path) => {
        const input = await fs.promises.readFile(path);

        const parsedInfo = parseFrontMatter(input);
        const { content: htmlContent } = parsedInfo;

        const linkedContent = await processor.process(htmlContent); // wrap headings in links

        // TODO: Find a better way, I don't want to parse this thing twice
        const ast = processor.parse(linkedContent.contents);
        const headings = findHeadings(ast);

        addNodeToCollection({
          content: processor.stringify(ast),
          headings,
          data: parsedInfo.data,
          path: `/${locale}/docs/${parsedInfo.data.slug}`,
        });
      });

    const mdPages = mdnContentFilenames
      .filter((path) => /\.md/.test(path)) // TODO: we'll need images here
      .filter((path) => !/\(/.test(path)) // TODO: fix vue router giving me an error on such paths
      .map(async (path) => {
        const input = await fs.promises.readFile(path);

        const parsedInfo = parseFrontMatter(input);
        const { content: mdContent } = parsedInfo;

        const linkedContent = await markdownProcessor.process(mdContent); // wrap headings in links

        // TODO: Find a better way, I don't want to parse this thing twice
        const ast = processor.parse(linkedContent);
        const headings = findHeadings(ast);

        addNodeToCollection({
          content: processor.stringify(ast),
          headings,
          data: parsedInfo.data,
          path: `/${locale}/docs/${parsedInfo.data.slug}`,
        });
      });

    await Promise.all([...htmlPages, ...mdPages]);
  });

  api.createPages(async ({ createPage, graphql }) => {
    // Use the Pages API here: https://gridsome.org/docs/pages-api/
  });
};

import { ConvertedNotionBlock } from '../../notion-rich-text-push-types';

export const CONTENT_MARKETING_BLOCKS = {
  children: [
    {
      id: '12345678-1234-4234-8234-123456789abc',
      object: 'block',
      has_children: false,
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Article Status: Final Review | Author: Sarah Chen | Category: Content Marketing | Reading Time: 22 min',
              link: null,
            },
            annotations: {
              bold: true,
              italic: true,
              strikethrough: true,
              underline: true,
              code: false,
              color: 'default',
            },
            plain_text:
              'Article Status: Final Review | Author: Sarah Chen | Category: Content Marketing | Reading Time: 22 min',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '23456789-2345-4345-8345-23456789abcd',
      object: 'block',
      has_children: false,
      type: 'image',
      image: {
        caption: [
          {
            type: 'text',
            text: {
              content: 'B2B Content Marketing Strategy Framework 2024',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'B2B Content Marketing Strategy Framework 2024',
            href: null,
          },
        ],
        type: 'external',
        external: {
          url: 'https://i.postimg.cc/Xqqv1mgg/SLH230168-22-l-lis.jpg',
        },
      },
    },
    {
      id: '34567890-3456-4456-8456-3456789abcde',
      object: 'block',
      has_children: false,
      type: 'heading_1',
      heading_1: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Introduction: The B2B Content Revolution',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Introduction: The B2B Content Revolution',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      id: '45678901-4567-4567-8567-456789abcdef',
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Content marketing has transformed from a nice-to-have into the backbone of successful B2B marketing strategies. In 2024, with buyers consuming an average of 13 pieces of content before making a purchase decision, your content strategy can make or break your pipeline.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Content marketing has transformed from a nice-to-have into the backbone of successful B2B marketing strategies. In 2024, with buyers consuming an average of 13 pieces of content before making a purchase decision, your content strategy can make or break your pipeline.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '56789012-5678-4678-8678-56789abcdef0',
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'This comprehensive guide draws from our experience working with 500+ B2B companies and analyzing over 10,000 content pieces to bring you actionable insights that drive real results.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'This comprehensive guide draws from our experience working with 500+ B2B companies and analyzing over 10,000 content pieces to bring you actionable insights that drive real results.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '67890123-6789-4789-8789-6789abcdef01',
      object: 'block',
      has_children: false,
      type: 'quote',
      quote: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                '"Content marketing generates 3x more leads than traditional marketing while costing 62% less." - Content Marketing Institute, 2024',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              '"Content marketing generates 3x more leads than traditional marketing while costing 62% less." - Content Marketing Institute, 2024',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '78901234-7890-4890-8890-789abcdef012',
      object: 'block',
      has_children: false,
      type: 'heading_2',
      heading_2: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: "What We'll Cover",
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: "What We'll Cover",
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      id: '89012345-8901-4901-8901-89abcdef0123',
      object: 'block',
      has_children: false,
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'The State of B2B Content Marketing in 2024',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'The State of B2B Content Marketing in 2024',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '90123456-9012-4012-8012-9abcdef01234',
      object: 'block',
      has_children: false,
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Building Your Content Strategy Foundation',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Building Your Content Strategy Foundation',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'a0123456-a012-4123-8123-abcdef012345',
      object: 'block',
      has_children: false,
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Content Types That Convert',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Content Types That Convert',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'b0123456-b012-4234-8234-bcdef0123456',
      object: 'block',
      has_children: false,
      type: 'divider',
      divider: {},
    },
    {
      id: 'c0123456-c012-4345-8345-cdef01234567',
      object: 'block',
      has_children: false,
      type: 'heading_1',
      heading_1: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: '1. The State of B2B Content Marketing in 2024',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: '1. The State of B2B Content Marketing in 2024',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      id: 'd0123456-d012-4456-8456-def012345678',
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                "The B2B content landscape has evolved dramatically. Buyers are more informed, skeptical, and selective about the content they consume. Let's examine the current state with hard data.",
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              "The B2B content landscape has evolved dramatically. Buyers are more informed, skeptical, and selective about the content they consume. Let's examine the current state with hard data.",
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'e0123456-e012-4567-8567-ef0123456789',
      object: 'block',
      has_children: false,
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Key Statistics:\n• 71% of B2B buyers consume blog content during their journey\n• Video content has 50x better ROI than text\n• Interactive content generates 2x more conversions\n• 87% of marketers use AI for content creation',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Key Statistics:\n• 71% of B2B buyers consume blog content during their journey\n• Video content has 50x better ROI than text\n• Interactive content generates 2x more conversions\n• 87% of marketers use AI for content creation',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'f0123456-f012-4678-8678-f012345678ab',
      object: 'block',
      has_children: false,
      type: 'heading_2',
      heading_2: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'The Shift to Quality Over Quantity',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'The Shift to Quality Over Quantity',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      id: '10123456-1012-4789-8789-012345678abc',
      object: 'block',
      has_children: false,
      type: 'heading_3',
      heading_3: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Content Length Trends',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Content Length Trends',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                "Gone are the days of content farms and keyword stuffing. Google's helpful content update and sophisticated buyer behaviors have forced a paradigm shift.",
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              "Gone are the days of content farms and keyword stuffing. Google's helpful content update and sophisticated buyer behaviors have forced a paradigm shift.",
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Our analysis of 10,000 B2B articles revealed that comprehensive guides (3,000+ words) generate 4x more organic traffic and 3.5x more backlinks than shorter pieces.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Our analysis of 10,000 B2B articles revealed that comprehensive guides (3,000+ words) generate 4x more organic traffic and 3.5x more backlinks than shorter pieces.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '20123456-2012-4890-8890-12345678abcd',
      object: 'block',
      has_children: true,
      type: 'table',
      table: {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
      },
      children: [
        {
          id: '30123456-3012-4901-8901-2345678abcde',
          object: 'block',
          has_children: false,
          type: 'table_row',
          table_row: {
            cells: [
              [
                {
                  type: 'text',
                  text: {
                    content: 'Word Count',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: 'Word Count',
                  href: null,
                },
              ],
              [
                {
                  type: 'text',
                  text: {
                    content: 'Metrics',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: 'Metrics',
                  href: null,
                },
              ],
            ],
          },
        },
        {
          id: '40123456-4012-4012-8012-345678abcdef',
          object: 'block',
          has_children: false,
          type: 'table_row',
          table_row: {
            cells: [
              [
                {
                  type: 'text',
                  text: {
                    content: '<1000 words',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '<1000 words',
                  href: null,
                },
              ],
              [
                {
                  type: 'text',
                  text: {
                    content: '450 visits/mo, 12 shares, 0.5% conversion',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '450 visits/mo, 12 shares, 0.5% conversion',
                  href: null,
                },
              ],
            ],
          },
        },
        {
          id: '50123456-5012-4123-8123-45678abcdef0',
          object: 'block',
          has_children: false,
          type: 'table_row',
          table_row: {
            cells: [
              [
                {
                  type: 'text',
                  text: {
                    content: '1000-2000 words',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '1000-2000 words',
                  href: null,
                },
              ],
              [
                {
                  type: 'text',
                  text: {
                    content: '890 visits/mo, 34 shares, 1.2% conversion',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '890 visits/mo, 34 shares, 1.2% conversion',
                  href: null,
                },
              ],
            ],
          },
        },
        {
          id: '60123456-6012-4234-8234-5678abcdef01',
          object: 'block',
          has_children: false,
          type: 'table_row',
          table_row: {
            cells: [
              [
                {
                  type: 'text',
                  text: {
                    content: '2000-3000 words',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '2000-3000 words',
                  href: null,
                },
              ],
              [
                {
                  type: 'text',
                  text: {
                    content: '1,670 visits/mo, 78 shares, 2.1% conversion',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '1,670 visits/mo, 78 shares, 2.1% conversion',
                  href: null,
                },
              ],
            ],
          },
        },
        {
          id: '70123456-7012-4345-8345-678abcdef012',
          object: 'block',
          has_children: false,
          type: 'table_row',
          table_row: {
            cells: [
              [
                {
                  type: 'text',
                  text: {
                    content: '>3000 words',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '>3000 words',
                  href: null,
                },
              ],
              [
                {
                  type: 'text',
                  text: {
                    content: '3,420 visits/mo, 156 shares, 3.8% conversion',
                    link: null,
                  },
                  annotations: {
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    underline: false,
                    code: false,
                    color: 'default',
                  },
                  plain_text: '3,420 visits/mo, 156 shares, 3.8% conversion',
                  href: null,
                },
              ],
            ],
          },
        },
      ],
    },
    {
      id: '80123456-8012-4456-8456-78abcdef0123',
      object: 'block',
      has_children: false,
      type: 'heading_3',
      heading_3: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Tracking Content Performance',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Tracking Content Performance',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'To measure content effectiveness, implement tracking scripts to monitor engagement metrics like time on page and conversion rates.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'To measure content effectiveness, implement tracking scripts to monitor engagement metrics like time on page and conversion rates.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '90123456-9012-4567-8567-8abcdef01234',
      object: 'block',
      has_children: false,
      type: 'code',
      code: {
        caption: [],
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                "function trackContentEngagement(event) {\n  analytics.track('ContentView', {\n    page: window.location.pathname,\n    timeSpent: getTimeOnPage()\n  });\n}",
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              "function trackContentEngagement(event) {\n  analytics.track('ContentView', {\n    page: window.location.pathname,\n    timeSpent: getTimeOnPage()\n  });\n}",
            href: null,
          },
        ],
        language: 'javascript',
      },
    },
    {
      id: 'a1123456-a112-4678-8678-9bcdef012345',
      object: 'block',
      has_children: false,
      type: 'heading_2',
      heading_2: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Content Consumption Patterns',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Content Consumption Patterns',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Understanding how B2B buyers consume content is crucial for strategy development. Our research identifies five distinct consumption phases.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Understanding how B2B buyers consume content is crucial for strategy development. Our research identifies five distinct consumption phases.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'b1123456-b112-4789-8789-acdef0123456',
      object: 'block',
      has_children: false,
      type: 'divider',
      divider: {},
    },
    {
      id: 'c1123456-c112-4890-8890-bdef01234567',
      object: 'block',
      has_children: false,
      type: 'heading_1',
      heading_1: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: '2. Building Your Content Strategy Foundation',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: '2. Building Your Content Strategy Foundation',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                "A successful content strategy starts with a solid foundation. Here's our proven framework for building one that delivers results.",
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              "A successful content strategy starts with a solid foundation. Here's our proven framework for building one that delivers results.",
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'd1123456-d112-4901-8901-cef012345678',
      object: 'block',
      has_children: false,
      type: 'heading_2',
      heading_2: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Step 1: Define Your Content Pillars',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Step 1: Define Your Content Pillars',
            href: null,
          },
        ],
        is_toggleable: false,
        color: 'default',
      },
    },
    {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Content pillars are the 3-5 core topics that support your brand narrative and business goals. They should align with your expertise and audience needs.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Content pillars are the 3-5 core topics that support your brand narrative and business goals. They should align with your expertise and audience needs.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'e1123456-e112-4012-8012-df0123456789',
      object: 'block',
      has_children: false,
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Pillar Example 1: Digital Transformation\n• Cloud migration\n• Process automation\n• Change management',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Pillar Example 1: Digital Transformation\n• Cloud migration\n• Process automation\n• Change management',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: 'f1123456-f112-4123-8123-e012345678ab',
      object: 'block',
      has_children: false,
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Pillar Example 2: Data Analytics\n• Business intelligence\n• Predictive analytics\n• Data governance',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Pillar Example 2: Data Analytics\n• Business intelligence\n• Predictive analytics\n• Data governance',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '11123456-1112-4234-8234-f12345678abc',
      object: 'block',
      has_children: false,
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Pillar Example 3: Customer Experience\n• Journey mapping\n• Personalization\n• Omnichannel strategy',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Pillar Example 3: Customer Experience\n• Journey mapping\n• Personalization\n• Omnichannel strategy',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '21123456-2112-4345-8345-012345678bcd',
      object: 'block',
      has_children: false,
      type: 'to_do',
      to_do: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: 'Define your content pillars and buyer personas',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text: 'Define your content pillars and buyer personas',
            href: null,
          },
        ],
        checked: false,
        color: 'default',
      },
    },
    {
      id: '31123456-3112-4456-8456-12345678acde',
      object: 'block',
      has_children: false,
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Ready to transform your content marketing? Download our complete B2B Content Marketing Playbook with templates, checklists, and frameworks.',
              link: null,
            },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default',
            },
            plain_text:
              'Ready to transform your content marketing? Download our complete B2B Content Marketing Playbook with templates, checklists, and frameworks.',
            href: null,
          },
        ],
        color: 'default',
      },
    },
    {
      id: '41123456-4112-4567-8567-2345678abdef',
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [],
        color: 'default',
      },
    },
  ] as ConvertedNotionBlock[],
};

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUserMessage,
  commandsFromLabels,
  findLocalCommands,
  groqErrorMessage,
  hostMatches,
  isGroupingRequest,
  parseCommands,
  parseLabels,
  resolveIndexes,
  siteTerm,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LABELS,
  trimUrl,
} from '../chrome-manager-frontend/lib.js';

const tab = (id, title, url, groupId = null) => ({ id, title, url, groupId });

describe('hostMatches', () => {
  it('matches a dotted domain exactly or as a suffix', () => {
    assert.ok(hostMatches('github.com', 'github.com'));
    assert.ok(hostMatches('www.github.com', 'github.com'));
    assert.ok(hostMatches('docs.stripe.com', 'stripe.com'));
  });

  it('does not match a domain that merely ends with the same letters', () => {
    // Regression: "netflix.com".includes("x.com") is true, so substring
    // matching pulled Netflix into "group x tabs".
    assert.equal(hostMatches('netflix.com', 'x.com'), false);
    assert.equal(hostMatches('notgithub.com', 'github.com'), false);
  });

  it('matches a bare term against any hostname label', () => {
    assert.ok(hostMatches('docs.stripe.com', 'stripe'));
    assert.ok(hostMatches('www.amazon.co.uk', 'amazon'));
    assert.equal(hostMatches('netflix.com', 'x'), false);
  });
});

describe('siteTerm', () => {
  it('accepts a bare site name and the usual filler around it', () => {
    for (const input of ['stripe', 'stripe tabs', 'all stripe tabs', 'my stripe pages', 'the stripe tabs']) {
      assert.equal(siteTerm(input), 'stripe', `failed on: ${input}`);
    }
  });

  it('rejects multi-word phrases and bare determiners', () => {
    for (const input of ['by topic', 'all tabs', 'everything', 'tabs', 'shopping stuff']) {
      assert.equal(siteTerm(input), null, `should not match: ${input}`);
    }
  });
});

describe('findLocalCommands — site grouping', () => {
  const tabs = [
    tab(1, 'Payments | Stripe', 'https://docs.stripe.com/payments'),
    tab(2, 'API | Stripe', 'https://docs.stripe.com/api'),
    tab(3, 'Notion', 'https://www.notion.so/abc'),
    tab(4, 'github - Google Search', 'https://www.google.com/search?q=github'),
    tab(5, 'GitHub', 'https://github.com/jingpeng7527'),
  ];

  it('groups a site named without the word "tabs"', () => {
    // Regression: the pattern required a trailing "tabs", so plain
    // "group stripe" fell through to the model and grouped the wrong tabs.
    assert.deepEqual(findLocalCommands('group stripe', tabs, []), [
      { action: 'group', tabIds: [1, 2], title: 'Stripe' },
    ]);
  });

  it('is case insensitive', () => {
    assert.deepEqual(
      findLocalCommands('Group Stripe', tabs, []),
      findLocalCommands('group stripe', tabs, []),
    );
  });

  it('matches on hostname, not on words in the title', () => {
    // Regression: a Google search *about* GitHub landed in the GitHub group.
    assert.deepEqual(findLocalCommands('group github tabs', tabs, []), [
      { action: 'group', tabIds: [5], title: 'Github' },
    ]);
  });

  it('adds to an existing group instead of creating a second one', () => {
    assert.deepEqual(findLocalCommands('group stripe', tabs, [{ id: 99, title: 'Stripe' }]), [
      { action: 'group', tabIds: [1, 2], groupId: 99 },
    ]);
  });

  it('defers to the model when the term matches no open tab', () => {
    assert.equal(findLocalCommands('group shopping', tabs, []), null);
  });

  it('defers to the model for requests needing judgement', () => {
    for (const input of ['group by topic', 'group all tabs', 'tidy these up']) {
      assert.equal(findLocalCommands(input, tabs, []), null, `should defer: ${input}`);
    }
  });
});

describe('findLocalCommands — ungroup', () => {
  const tabs = [
    tab(1, 'A', 'https://docs.stripe.com/a', 7),
    tab(2, 'B', 'https://docs.stripe.com/b', 7),
    tab(3, 'C', 'https://notion.so/c'),
  ];

  it('ungroups every grouped tab and leaves loose tabs alone', () => {
    assert.deepEqual(findLocalCommands('ungroup all', tabs, []), [
      { action: 'ungroup', tabIds: [1, 2] },
    ]);
    assert.deepEqual(
      findLocalCommands('ungroup everything', tabs, []),
      findLocalCommands('ungroup all', tabs, []),
    );
  });

  it('reports nothing to do when no tab is grouped', () => {
    assert.deepEqual(findLocalCommands('ungroup all', [tab(1, 'A', 'https://a.com')], []), []);
  });

  it('ungroups a single site', () => {
    assert.deepEqual(findLocalCommands('ungroup stripe', tabs, []), [
      { action: 'ungroup', tabIds: [1, 2] },
    ]);
  });
});

describe('findLocalCommands — duplicates', () => {
  it('closes only genuine duplicates', () => {
    // Regression: the key ignored the query string, so two different YouTube
    // videos looked identical and one was closed.
    const tabs = [
      tab(1, 'A', 'https://youtube.com/watch?v=AAA'),
      tab(2, 'B', 'https://youtube.com/watch?v=BBB'),
      tab(3, 'A again', 'https://youtube.com/watch?v=AAA'),
      tab(4, 'A at 30s', 'https://youtube.com/watch?v=AAA#t=30'),
    ];
    assert.deepEqual(findLocalCommands('close duplicates', tabs, []), [
      { action: 'remove', tabId: 3 },
      { action: 'remove', tabId: 4 },
    ]);
  });
});

describe('parseCommands', () => {
  const expected = [{ action: 'group', tabIds: [1, 2], title: 'Docs' }];
  const inner = '[{"action":"group","tabIds":[1,2],"title":"Docs"}]';

  it('accepts every key a model plausibly uses, and a bare array', () => {
    assert.deepEqual(parseCommands(`{"commands": ${inner}}`), expected);
    assert.deepEqual(parseCommands(`{"actions": ${inner}}`), expected);
    assert.deepEqual(parseCommands(`{"result": ${inner}}`), expected);
    assert.deepEqual(parseCommands(inner), expected);
  });

  it('digs the JSON out of fences and prose', () => {
    assert.deepEqual(parseCommands('```json\n{"commands": ' + inner + '}\n```'), expected);
    assert.deepEqual(parseCommands('Sure! Here you go:\n{"commands": ' + inner + '}'), expected);
  });

  it('returns nothing rather than throwing on junk', () => {
    for (const input of ['', 'I cannot help with that.', '{"commands": [oops}', '{"foo": 1}']) {
      assert.deepEqual(parseCommands(input), [], `should be empty: ${input}`);
    }
  });
});

describe('resolveIndexes', () => {
  const tabs = [
    tab(1598231270, 'AWS Console', 'https://console.aws.amazon.com'),
    tab(1598230900, 'AWS S3', 'https://s3.console.aws.amazon.com'),
    tab(1598230903, 'AWS EC2', 'https://ec2.console.aws.amazon.com'),
  ];
  const groups = [{ id: 77, title: 'Work' }];

  it('maps 1..N back to real Chrome tab ids', () => {
    assert.deepEqual(
      resolveIndexes([{ action: 'group', tabIds: [1, 2, 3], title: 'AWS' }], tabs, groups),
      [{ action: 'group', tabIds: [1598231270, 1598230900, 1598230903], title: 'AWS' }],
    );
  });

  it('drops ids the model ran together into one number', () => {
    // Regression: the model emitted 1598231270 + 1598230900 + 1598230903 as a
    // single 30-digit number. It must not resolve to some unrelated tab.
    assert.deepEqual(
      resolveIndexes(
        [{ action: 'group', tabIds: [159823127015982309001598230903], title: 'AWS' }],
        tabs,
        groups,
      ),
      [],
    );
  });

  it('drops out-of-range indexes but keeps the valid ones', () => {
    assert.deepEqual(
      resolveIndexes([{ action: 'group', tabIds: [1, 99, 2], title: 'AWS' }], tabs, groups),
      [{ action: 'group', tabIds: [1598231270, 1598230900], title: 'AWS' }],
    );
  });

  it('maps a group index, and falls back to a new group when it is bogus', () => {
    assert.deepEqual(
      resolveIndexes([{ action: 'group', tabIds: [1, 2], groupId: 1 }], tabs, groups),
      [{ action: 'group', tabIds: [1598231270, 1598230900], groupId: 77 }],
    );
    assert.deepEqual(
      resolveIndexes([{ action: 'group', tabIds: [1, 2], groupId: 9, title: 'AWS' }], tabs, groups),
      [{ action: 'group', tabIds: [1598231270, 1598230900], title: 'AWS' }],
    );
  });

  it('maps remove, duplicate and ungroup', () => {
    assert.deepEqual(
      resolveIndexes(
        [
          { action: 'remove', tabId: 3 },
          { action: 'duplicate', tabId: 1 },
          { action: 'ungroup', tabIds: [1, 2] },
        ],
        tabs,
        groups,
      ),
      [
        { action: 'remove', tabId: 1598230903 },
        { action: 'duplicate', tabId: 1598231270 },
        { action: 'ungroup', tabIds: [1598231270, 1598230900] },
      ],
    );
  });
});

describe('commandsFromLabels', () => {
  const tabs = [
    tab(101, 'AWS Console', 'https://aws.amazon.com'),
    tab(102, 'AWS S3', 'https://s3.aws.amazon.com'),
    tab(103, 'Datadog APM', 'https://app.datadoghq.com/apm'),
    tab(104, 'Datadog Logs', 'https://app.datadoghq.com/logs'),
    tab(105, 'LinkedIn Feed', 'https://www.linkedin.com/feed'),
  ];

  it('builds one group per distinct label', () => {
    const reply = '{"labels":{"1":"AWS","2":"AWS","3":"Datadog","4":"Datadog","5":"none"}}';
    assert.deepEqual(commandsFromLabels(parseLabels(reply), tabs, []), [
      { action: 'group', tabIds: [101, 102], title: 'AWS' },
      { action: 'group', tabIds: [103, 104], title: 'Datadog' },
    ]);
  });

  it('never creates a group from a single mislabelled tab', () => {
    // Regression: one LinkedIn tab was labelled "Datadog" and became a group
    // on its own. Requiring two tabs contains that mistake.
    const reply = '{"labels":{"5":"Datadog","1":"AWS","2":"AWS"}}';
    assert.deepEqual(commandsFromLabels(parseLabels(reply), tabs, []), [
      { action: 'group', tabIds: [101, 102], title: 'AWS' },
    ]);
  });

  it('merges labels that differ only by case', () => {
    assert.deepEqual(commandsFromLabels(parseLabels('{"labels":{"1":"AWS","2":"aws"}}'), tabs, []), [
      { action: 'group', tabIds: [101, 102], title: 'AWS' },
    ]);
  });

  it('reuses an existing group with the same name', () => {
    assert.deepEqual(
      commandsFromLabels(parseLabels('{"labels":{"1":"AWS","2":"AWS"}}'), tabs, [{ id: 55, title: 'aws' }]),
      [{ action: 'group', tabIds: [101, 102], groupId: 55 }],
    );
  });

  it('ignores tab numbers outside the list', () => {
    assert.deepEqual(
      commandsFromLabels(parseLabels('{"labels":{"1":"AWS","2":"AWS","99":"AWS"}}'), tabs, []),
      [{ action: 'group', tabIds: [101, 102], title: 'AWS' }],
    );
  });

  it('keeps fine-grained multi-word labels separate', () => {
    const fine = [
      tab(1, 'Leetcode', 'https://leetcode.com'),
      tab(2, 'System Design', 'https://github.com/donnemartin/system-design-primer'),
      tab(3, 'LinkedIn Jobs', 'https://linkedin.com/jobs'),
      tab(4, 'Indeed', 'https://indeed.com'),
    ];
    const reply =
      '{"labels":{"1":"Interview Prep","2":"Interview Prep","3":"Job Listings","4":"Job Listings"}}';
    assert.deepEqual(commandsFromLabels(parseLabels(reply), fine, []), [
      { action: 'group', tabIds: [1, 2], title: 'Interview Prep' },
      { action: 'group', tabIds: [3, 4], title: 'Job Listings' },
    ]);
  });

  it('survives fenced and malformed replies', () => {
    const reply = '{"labels":{"1":"AWS","2":"AWS"}}';
    assert.equal(commandsFromLabels(parseLabels('```json\n' + reply + '\n```'), tabs, []).length, 1);
    assert.deepEqual(commandsFromLabels(parseLabels('not json at all'), tabs, []), []);
  });

  it('accepts a bare object without the labels key', () => {
    assert.deepEqual(commandsFromLabels(parseLabels('{"1":"AWS","2":"AWS"}'), tabs, []), [
      { action: 'group', tabIds: [101, 102], title: 'AWS' },
    ]);
  });
});

describe('isGroupingRequest', () => {
  it('routes organising requests to labelling', () => {
    for (const input of ['Group by topic', 'organize my tabs', 'sort these', 'tidy up']) {
      assert.ok(isGroupingRequest(input), `should label: ${input}`);
    }
  });

  it('leaves other requests on the command format', () => {
    for (const input of ['close all youtube tabs', 'duplicate this tab']) {
      assert.equal(isGroupingRequest(input), false, `should not label: ${input}`);
    }
  });
});

describe('buildUserMessage', () => {
  it('numbers tabs from 1 and never exposes a Chrome id', () => {
    const tabs = [
      tab(1598231270, 'AWS Console', 'https://console.aws.amazon.com/home'),
      tab(1598230900, 'Stripe Docs', 'https://docs.stripe.com/api', 42),
    ];
    const message = buildUserMessage(tabs, [{ id: 42, title: 'Work' }], 'group by topic');

    assert.match(message, /^1\. AWS Console/m);
    assert.match(message, /^2\. Stripe Docs/m);
    assert.match(message, /\[group 1\]/);
    assert.match(message, /User Request: group by topic/);
    assert.doesNotMatch(message, /1598231270|1598230900/, 'raw Chrome ids must not reach the model');
  });

  it('says "none" when there are no groups', () => {
    assert.match(buildUserMessage([], [], 'hi'), /Existing groups:\nnone/);
  });
});

describe('groqErrorMessage', () => {
  it('appends what the model produced when JSON mode rejects a reply', () => {
    // The real shape of a JSON-mode rejection. Reading only error.message
    // reports "adjust your prompt" and silently drops the evidence of why.
    const payload = {
      error: {
        message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
        failed_generation: '{"labels": {"1": "Cloud Console", "2": "Cloud',
      },
    };
    const message = groqErrorMessage(payload, 400);
    assert.match(message, /Failed to validate JSON/);
    assert.match(message, /\{"labels": \{"1": "Cloud Console"/, 'must show the truncated output');
  });

  it('truncates a very long failed generation', () => {
    const payload = { error: { message: 'bad', failed_generation: 'x'.repeat(5000) } };
    assert.ok(groqErrorMessage(payload, 400).length < 300);
  });

  it('falls back to the status when the body is unhelpful', () => {
    assert.equal(groqErrorMessage({}, 500), 'Groq error: 500');
    assert.equal(groqErrorMessage(null, 502), 'Groq error: 502');
    assert.equal(groqErrorMessage({ error: { message: 'Invalid API Key' } }, 401), 'Invalid API Key');
  });
});

describe('system prompts', () => {
  const exampleOf = (prompt) => prompt.match(/\{"labels".*?\}\}/)[0];

  it('shows the model an example our own parser accepts', () => {
    // The example is a contract between the prompt and parseLabels. If one
    // drifts from the other, the model is being shown a shape we cannot read.
    const labels = parseLabels(exampleOf(SYSTEM_PROMPT_LABELS));
    assert.ok(labels, 'the example in the prompt must parse');
  });

  it('repeats a label, since that is the rule the design depends on', () => {
    // commandsFromLabels buckets on the exact string: two tabs labelled "AWS"
    // and "Amazon Web Services" fall into separate buckets, neither reaches the
    // two-tab minimum, and no group is created. The example teaches this by
    // using one label twice — a well-meaning tidy-up to three distinct labels
    // would silently remove the demonstration.
    const values = Object.values(parseLabels(exampleOf(SYSTEM_PROMPT_LABELS)));
    assert.ok(values.length > new Set(values).size, 'example must reuse one label');
    assert.ok(new Set(values).size > 1, 'example must also show a second group');
  });

  it('produces a real group when run through our own pipeline', () => {
    const labels = parseLabels(exampleOf(SYSTEM_PROMPT_LABELS));
    const tabs = Object.keys(labels).map((k) => tab(Number(k) * 10, `Tab ${k}`, `https://x${k}.com`));
    const commands = commandsFromLabels(labels, tabs, []);

    assert.equal(commands.length, 1, 'the repeated label should form exactly one group');
    assert.equal(commands[0].action, 'group');
    assert.equal(commands[0].tabIds.length, 2);
  });

  it('keeps the command prompt free of raw Chrome ids', () => {
    assert.match(SYSTEM_PROMPT, /numbered 1\.\.N/);
    assert.doesNotMatch(SYSTEM_PROMPT, /\d{9,}/, 'no long ids should appear as examples');
  });
});

describe('trimUrl', () => {
  it('keeps origin and path, dropping query and fragment', () => {
    assert.equal(trimUrl('https://docs.stripe.com/api?x=1#y'), 'https://docs.stripe.com/api');
  });

  it('keeps schemes that have no origin distinguishable', () => {
    // Regression: URL reports origin "null" for chrome: and about:, so every
    // such tab was shown to the model as the literal string "null".
    assert.equal(trimUrl('chrome://extensions'), 'chrome://extensions');
    assert.equal(trimUrl('chrome://newtab/'), 'chrome://newtab/');
    assert.equal(trimUrl('about:blank'), 'about:blank');
  });

  it('survives a value that is not a URL at all', () => {
    assert.equal(trimUrl('not a url'), 'not a url');
    assert.equal(trimUrl(undefined), '');
  });
});

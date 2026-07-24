const DIFF_PROVIDER_KEY = 'ms.vss-code-web.file-diff-data-provider';
const CONTEXT_LINE_COUNT = 3;
const ORIGINAL_FETCH = window.fetch;

window.fetch = async function (...fetchArgs) {
  const response = await ORIGINAL_FETCH.apply(this, fetchArgs);
  try {
    return await maybeRewriteResponse(fetchArgs[0], response);
  } catch (_error) {
    return response;
  }
};

async function maybeRewriteResponse(requestInfo, response) {
  const requestUrl = typeof requestInfo === 'string' ? requestInfo : (requestInfo && requestInfo.url) || '';
  if (!requestUrl.includes('/_apis/Contribution/HierarchyQuery')) {
    return response;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(await response.clone().text());
  } catch (_error) {
    return response;
  }

  const providerData = responseJson.dataProviders?.[DIFF_PROVIDER_KEY];
  if (!providerData || (!providerData.originalFileTruncated && !providerData.modifiedFileTruncated)) {
    return response;
  }

  const rebuiltProviderData = await rebuildProviderDiff(providerData);
  if (!rebuiltProviderData) {
    return response;
  }

  Object.assign(providerData, rebuiltProviderData);

  return new Response(JSON.stringify(responseJson), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function rebuildProviderDiff(providerData) {
  if (!globalThis.Diff || typeof globalThis.Diff.diffLines !== 'function') {
    return null;
  }

  const originalFileText = await fetchBlobText(
    providerData.originalFile.serverItem,
    providerData.originalFile.version
  );
  const modifiedFileText = await fetchBlobText(
    providerData.modifiedFile.serverItem,
    providerData.modifiedFile.version
  );

  const lineDiffChanges = globalThis.Diff.diffLines(originalFileText, modifiedFileText);
  const rebuiltBlocks = mapDiffChangesToAdoBlocks(lineDiffChanges);

  const rebuiltProviderData = {
    blocks: rebuiltBlocks,
    lineCharBlocks: rebuiltBlocks.map((lineChange) => ({
      lineChange,
      charChange: lineChange.changeType === 3
        ? buildModifiedCharChanges(lineChange)
        : [],
    })),
    originalFileTruncated: false,
    modifiedFileTruncated: false,
  };
  if ('whitespaceChangesOnly' in providerData) {
    rebuiltProviderData.whitespaceChangesOnly = false;
  }
  return rebuiltProviderData;
}

function getRepoScopeFromUrl() {
  const match = location.pathname.match(/^\/([^/]+)\/_git\/([^/]+)/);
  if (!match) {
    throw new Error('Failed to parse project and repository name from URL: ' + location.pathname);
  }
  return { projectName: match[1], repositoryName: match[2] };
}

async function fetchBlobText(serverItemPath, gitVersion) {
  const scope = getRepoScopeFromUrl();

  const commitSha = String(gitVersion || '').replace(/^GC/, '');
  const requestUrl = `/${scope.projectName}/_apis/git/repositories/${scope.repositoryName}/items?path=${encodeURIComponent(serverItemPath)}&versionType=commit&version=${commitSha}&$format=text&api-version=5.0`;

  const response = await ORIGINAL_FETCH(requestUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Failed to fetch blob text: ' + response.status);
  }
  return response.text();
}

function mapDiffChangesToAdoBlocks(diffChanges) {
  const diffBlocks = [];
  let originalLineNumber = 1;
  let modifiedLineNumber = 1;

  for (let changeIndex = 0; changeIndex < diffChanges.length; changeIndex += 1) {
    const currentChange = diffChanges[changeIndex];
    if (!currentChange.added && !currentChange.removed) {
      const contextLines = flattenDiffChangeLines(currentChange.value);
      const contextBlocks = buildContextBlocks(
        contextLines,
        originalLineNumber,
        modifiedLineNumber,
        changeIndex === 0,
        changeIndex === diffChanges.length - 1
      );
      diffBlocks.push(...contextBlocks);
      originalLineNumber += contextLines.length;
      modifiedLineNumber += contextLines.length;
      continue;
    }

    const changeStartOriginalLine = originalLineNumber;
    const changeStartModifiedLine = modifiedLineNumber;
    const removedLines = [];
    const addedLines = [];

    while (changeIndex < diffChanges.length && (diffChanges[changeIndex].added || diffChanges[changeIndex].removed)) {
      const diffChange = diffChanges[changeIndex];
      const diffChangeLines = flattenDiffChangeLines(diffChange.value);
      if (diffChange.removed) {
        removedLines.push(...diffChangeLines);
        originalLineNumber += diffChangeLines.length;
      }
      if (diffChange.added) {
        addedLines.push(...diffChangeLines);
        modifiedLineNumber += diffChangeLines.length;
      }
      changeIndex += 1;
    }

    changeIndex -= 1;
    const hasRemovedLines = removedLines.length > 0;
    const hasAddedLines = addedLines.length > 0;
    const changeType = hasRemovedLines && hasAddedLines ? 3 : (hasAddedLines ? 1 : 2);

    diffBlocks.push({
      changeType,
      oLine: changeStartOriginalLine,
      oLinesCount: removedLines.length,
      oLines: removedLines,
      mLine: changeStartModifiedLine,
      mLinesCount: addedLines.length,
      mLines: addedLines,
    });
  }

  return diffBlocks;
}

function buildContextBlocks(lines, originalStartLine, modifiedStartLine, isLeadingContext, isTrailingContext) {
  const fullLineCount = lines.length;
  if (fullLineCount === 0) {
    return [];
  }

  if (isLeadingContext && fullLineCount > CONTEXT_LINE_COUNT) {
    return [
      createContextBlock(
        originalStartLine + fullLineCount - CONTEXT_LINE_COUNT,
        modifiedStartLine + fullLineCount - CONTEXT_LINE_COUNT,
        fullLineCount,
        lines.slice(fullLineCount - CONTEXT_LINE_COUNT),
        { truncatedBefore: true }
      ),
    ];
  }

  if (isTrailingContext && fullLineCount > CONTEXT_LINE_COUNT) {
    return [
      createContextBlock(
        originalStartLine,
        modifiedStartLine,
        fullLineCount,
        lines.slice(0, CONTEXT_LINE_COUNT),
        { truncatedAfter: true }
      ),
    ];
  }

  if (!isLeadingContext && !isTrailingContext && fullLineCount > 2 * CONTEXT_LINE_COUNT) {
    return [
      createContextBlock(
        originalStartLine,
        modifiedStartLine,
        fullLineCount,
        lines.slice(0, CONTEXT_LINE_COUNT),
        { truncatedAfter: true }
      ),
      createContextBlock(
        originalStartLine + fullLineCount - CONTEXT_LINE_COUNT,
        modifiedStartLine + fullLineCount - CONTEXT_LINE_COUNT,
        fullLineCount,
        lines.slice(fullLineCount - CONTEXT_LINE_COUNT),
        { truncatedBefore: true }
      ),
    ];
  }

  return [createContextBlock(originalStartLine, modifiedStartLine, fullLineCount, lines)];
}

function createContextBlock(originalStartLine, modifiedStartLine, fullLineCount, visibleLines, truncationFlags) {
  return Object.assign(
    {
      changeType: 0,
      oLine: originalStartLine,
      oLinesCount: fullLineCount,
      oLines: visibleLines,
      mLine: modifiedStartLine,
      mLinesCount: fullLineCount,
      mLines: visibleLines,
    },
    truncationFlags || {}
  );
}

function flattenDiffChangeLines(changeValue) {
  return splitNormalizedLines(changeValue);
}

function splitNormalizedLines(text) {
  if (text.length === 0) {
    return [];
  }
  const normalizedText = text.replace(/\r\n?/g, '\n');
  const lines = normalizedText.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function buildModifiedCharChanges(lineChange) {
  if (!globalThis.Diff || typeof globalThis.Diff.diffChars !== 'function') {
    return [];
  }

  const originalText = Array.isArray(lineChange.oLines) ? lineChange.oLines.join('') : '';
  const modifiedText = Array.isArray(lineChange.mLines) ? lineChange.mLines.join('') : '';
  const diffChanges = globalThis.Diff.diffChars(originalText, modifiedText);

  const charChanges = [];
  let originalCharPosition = 0;
  let modifiedCharPosition = 0;

  for (const diffChange of diffChanges) {
    const segmentLength = diffChange.value.length;
    if (segmentLength === 0) {
      continue;
    }

    if (diffChange.removed) {
      charChanges.push({
        changeType: 2,
        oLine: originalCharPosition,
        oLinesCount: segmentLength,
        mLine: modifiedCharPosition,
        mLinesCount: 0,
      });
      originalCharPosition += segmentLength;
      continue;
    }

    if (diffChange.added) {
      charChanges.push({
        changeType: 1,
        oLine: originalCharPosition,
        oLinesCount: 0,
        mLine: modifiedCharPosition,
        mLinesCount: segmentLength,
      });
      modifiedCharPosition += segmentLength;
      continue;
    }

    originalCharPosition += segmentLength;
    modifiedCharPosition += segmentLength;
  }

  return charChanges;
}

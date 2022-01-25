/*
  The MIT License
  
  Copyright (c) 2021 EclipseSource Munich
  
  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:
  
  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.
  
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/

const fs = require('fs')
const { graphql } = require('@octokit/graphql');

// CONFIG START

// In order to access private repositories or to prevent hitting the github API limit put your personal access token here.
const personalAccessToken = '';
const owner = 'sdirix';
const repoName = 'example-workflows';

const milestoneNumber = '1'; // Inspect milestone url to get assigned number
const defaultTeamName = 'EclipseSource';
const labelToTeamName = {
  'foo': 'Foobar',
}
const mailToTeamName = {
  'eclipsesource.com': 'EclipseSource',
  'foobar.foobar': 'Foobar'
}
const startCommit = 'ed2872fe3fe6897a205a01f390832a37db88bee3'; // First commit to be considered
const endCommit = '2c604ba8f6f9b77947b7d8e1cb79de985737808c'; // Last commit to be considered
const startDate = ''; // default date is startCommit date
const endDate = ''; // default date is endCommit date
const blacklistIssues = ['invalid']; // exclude issues with one of these labels
const whitelistIssues = []; // exlude all issues NOT with one of these labels - otherwise leave empty
let branch = 'main';
// CONFIG END

if (!personalAccessToken) {
  throw "Please provide a personal Access Token to use GitHub's GraphQL endpoint.";
}
const graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${personalAccessToken}`,
        accept:
          "application/vnd.github.antiope-preview+json, application/vnd.github.merge-info-preview+json"
      }
});
    
async function getIssues() {
  return await graphqlWithAuth(`{
  repository(name: "${repoName}", owner: "${owner}") {
    url
    id
    milestone(number: ${milestoneNumber}) {
      title
      dueOn
      url
      issues(first:100) {
        totalCount
        nodes {
          id
          url
          title
          state
          number
          labels(first:20) {
            nodes {
              name
            }
          }
        }
      }
    }
    defaultBranchRef {
      name
    }
  }
}`);
}

async function getCommits() {
  let startCommitIndex = -1;
  let cursor = '';
  commits = [];
  while(startCommitIndex === -1){
    let query = await graphqlWithAuth(`{
      repository(name: "${repoName}", owner: "${owner}") {
        defaultBranchRef {
          name
        }
        ref(qualifiedName: "${branch}"){
          target {
            ... on Commit {
              history(first: 100${(cursor) && ', after:"' + (cursor) + '"'}){
                edges {
                  node {
                    messageHeadline
                    message
                    oid
                    abbreviatedOid
                    url
                    committedDate
                    author {
                      email
                    }
                    associatedPullRequests(first:10) {
                      nodes {
                        title
                        createdAt
                        mergedAt
                        body
                        url
                        state
                        headRef {
                          name
                        }
                        author {
                          login
                        }
                        closingIssuesReferences(first:10) {
                          nodes {
                            title
                            number
                            url
                          }
                        }
                        
                      }
                    }
                  }
                  cursor
                }
              }
            }
          }
        }
      }
    }`);
    let queryCommits = query.repository.ref.target.history.edges;
    cursor = queryCommits[queryCommits.length - 1].cursor;
    
    startCommitIndex = queryCommits.map(c => c.node.oid).indexOf(startCommit);
    if (startCommitIndex !== -1){
      queryCommits.length = startCommitIndex + 1;
    }
    if (commits.length === 0){
      const endCommitIndex = queryCommits.map(c => c.node.oid).indexOf(endCommit);
      if (endCommitIndex !== -1){
        queryCommits.splice(0, endCommitIndex);
        commits = queryCommits;
      }
    } else {
      commits.push(...queryCommits);
    }
  }
  return commits;
}

// Get open PR's (merged PR's are retrieved through commits)
async function getPRs() {
  return await graphqlWithAuth(`{
  search(query: "repo:${owner}/${repoName} is:pr is:open", type: ISSUE, last: 100) {
    nodes {
      ... on PullRequest {
        title
        createdAt
        mergedAt
        body
        url
        state
        headRef {
          name
        }
        author {
          login
        }
        closingIssuesReferences(first:10) {
          nodes {
            title
            number
            url
          }
        }
      }      
    }
  }
}`);
}

// THE MAIN FUNCTION
(async () => {
  try {
    
    let notAssignableCommits = [];

    // Get issues for milestone
    const repo = await getIssues();
    let issues = repo.repository.milestone?.issues?.nodes;
    if (!branch) {
      branch = repo.repository.defaultBranchRef.name;
    }
    if (!issues || !issues.length){
      throw `No issues found for milestone ${milestoneNumber}`;
    }

    // Get Commits
    const commits = await getCommits();

    let prCount = 0;
    let commitCount = commits.length;

    commits.map(commit => {
      const authorDomain = commit.node.author.email.match(/(?:@)(.*)/)[1];
      if (mailToTeamName[authorDomain]) {
        commit.node.team = mailToTeamName[authorDomain]
      }

      // Get linked issues via commit message
      let matches = [];

      let prs = commit.node.associatedPullRequests.nodes;
      if (prs.length === 1){
        let pr = prs[0];
        if (pr.closingIssuesReferences.nodes.length > 0) {
          pr.closingIssuesReferences.nodes.map(issueRef => {
            const index = issues.map(issue => issue.number).indexOf(issueRef.number);
            if (index >= 0 && index < issues.length) {
              matches.push(issueRef.number);
              if (!issues[index].prs){
                issues[index].prs = [pr]
                prCount++;
              } else if (!issues[index].prs.some(p => p.url === pr.url)) {
                issues[index].prs.push(pr);
                prCount++;
              }
            }
          });
        }
        // Get issue linked to pr via branch-name
        else if (pr.headref && pr.headRef.name.search(/gh-?/i) !== -1) {
          const issueNumber = Number(pr.headRef.name.match(/(?:gh-?)([0-9]+)/i)[1]);
          const index = issues.map(issue => issue.number).indexOf(issueNumber);
          if (index >= 0 && index < issues.length && (!issues[index].prs || !issues[index].prs.includes(pr))) {
            matches.push(issueRef.number);
            (issues[index].prs) ? issues[index].prs.push(pr) : issues[index].prs = [pr];
            prCount++;
          }
        }
      }

      if (matches.length === 0){
        if (commit.node.messageHeadline.search(/(gh-)([0-9]+)/i) !== -1) {
          matches = commit.node.messageHeadline.match(/(gh-)([0-9]+)/ig);
        } else if (commit.node.message.search(/((fix|resolve|close).*(gh-)|#)([0-9]+)/i) !== -1) {
          matches = commit.node.message.match(/((fix|resolve|close).*(gh-)|#)([0-9]+)/ig);
        } else if (commit.node.message.search(/((gh-)|#)([0-9]+)/i) !== -1) {
          matches = commit.node.message.match(/((gh-)|#)([0-9]+)/ig);
        }
        matches = matches.map(issue => Number(issue.match(/(?:gh-|#)([0-9]+)/i)[1]));
      }
      
      if (matches) {
        let hasIssue = false;
        matches.map(issueNo => {
          const index = issues.map(issue => issue.number).indexOf(issueNo);
          if (index >= 0 && index < issues.length) {
            (issues[index].commits) ? issues[index].commits.push(commit.node) : issues[index].commits = [commit.node];
            hasIssue = true;
          } else {
            commit.node.warning = 'Commit is linking to issue not in milestone'
          }
        });
        if (!hasIssue) {
          notAssignableCommits.push(commit.node)
        }
      } else {
        commit.node.warning = 'Commit not linking to any issue'
        notAssignableCommits.push(commit.node);
      }
    });

    // Get open PR's
    const query = await getPRs();
    const prs = query.search.nodes;
    prs.map((pr, i) => {
      if (pr.closingIssuesReferences.nodes.length > 0) {
        pr.closingIssuesReferences.nodes.map(issueRef => {
          const index = issues.map(issue => issue.number).indexOf(issueRef.number);
          if (index >= 0 && index < issues.length) {
            (issues[index].prs) ? issues[index].prs.push(pr) : issues[index].prs = [pr];
            prCount++;
          }
        });
      }
      // Get issue linked to pr via branch-name
      else if (pr.headRef.name.search(/gh-?/i) !== -1) {
        const issueNumber = Number(pr.headRef.name.match(/(?:gh-?)([0-9]+)/i)[1]);
        const index = issues.map(issue => issue.number).indexOf(issueNumber);
        if (index >= 0 && index < issues.length) {
          (issues[index].prs) ? issues[index].prs.push(pr) : issues[index].prs = [pr];
          prCount++;
        }
      }
    });

    issues = issues.filter(issue => {
      let filtered = !issue.labels.nodes.some(label => blacklistIssues.includes(label.name));
      if (!filtered){
        prCount -= issue.prs.length;
        commitCount -= issue.commits.length;
      }
      return filtered;
    });
    if (whitelistIssues.length > 0) {
      issues = issues.filter(issue => {
        let filtered = issue.labels.nodes.some(label => whitelistIssues.includes(label.name));
        if (!filtered){
          prCount -= issue.prs.length;
          commitCount -= issue.commits.length;
        }
        return filtered;
      });
    }

    // Markdown Generation
    const dateFormat = {year: 'numeric', month: 'long', day: 'numeric'}


    let output = `# ${repo.repository.milestone.title} Contribution Report

Repository: [${owner}/${repoName}](${repo.repository.url})

Sprint Start (inclusive): ${new Date((startDate) ? startDate : commits[commits.length-1].node.committedDate).toLocaleDateString("en-US", dateFormat)}  
Sprint End (inclusive): ${new Date((endDate) ? endDate : commits[0].node.committedDate).toLocaleDateString("en-US", dateFormat)}

Milestone: [${repo.repository.milestone.title}](${repo.repository.milestone.url})  
Number of issues: ${issues.length}

Considered branch: ${branch}  
Start Commit (inclusive): [${commits[commits.length-1].node.oid}](${commits[commits.length-1].node.url})  
End Commit (inclusive): [${commits[0].node.oid}](${commits[0].node.url})  
Number of commits: ${commitCount}  
Number of pull requests:  ${prCount}

## Issues
`;
    
    issues.map(issue => {
      let issueTeams = []
      issue.labels.nodes.map(label => {
        if (labelToTeamName[label.name]) {
          issueTeams.push(labelToTeamName[label.name])
        }
      });
      if (issueTeams.length === 0) {
        issueTeams.push(defaultTeamName);
      }

      output += `\n### ${issue.title}\n\n`

      if (issue.state === 'OPEN') {
        output += '*Warning: Issue is still open.*\n\n';
      }
        
      output += `Id: #${issue.number}  \nLink: <${issue.url}>  \n`;

      
      if (!issue.prs) {
        output += `Associated PR: No pull-request linked to this issue found in this sprint  \n`;
      } else if (issue.prs.length === 1) {
        output += `Associated PR: <${issue.prs[0].url}>  \n`;
        if (issue.prs[0].state !== 'MERGED') {
          output += `*Warning: pull-request state is ${issue.prs[0].state}*\n`;
        }
        const mergedAt = new Date(issue.prs[0].mergedAt)
        if (mergedAt > new Date(endDate) ) {
          output += `*Warning: PR <${issue.prs[0].url}> merged after Sprint*  \n`;
        } else if (mergedAt < new Date(startDate)) {
          output += `*Warning: PR <${issue.prs[0].url}> merged before Sprint*  \n`;
        }
      } else {
        output += `Associated PRs:\n\n`;
        issue.prs.map(pr => {
          output += `- <${pr.url}>  \n`;
          if (pr.state !== 'MERGED') {
            output += `*Warning: pull-request state is ${pr.state}*  \n`;
          } else {
            const mergedAt = new Date(pr.mergedAt)
            if (mergedAt > new Date(endDate) ) {
              output += `*Warning: PR <${pr.url}> merged after Sprint*  \n`;
            } else if (mergedAt < new Date(startDate)) {
              output += `*Warning: PR <${pr.url}> merged before Sprint*  \n`;
            }
          }
        });
      }
      let hasDifferentTeamCommits = false;
      if (!issue.commits) {
        output += `Associated Commits: No commits linked to this issue found in this sprint  \n`;
      } else {
        hasDifferentTeamCommits = !issue.commits.every(commit => commit.team === issue.commits[0].team);
        if (issue.commits.length === 1) {
          output += `Associated Commit: [${issue.commits[0].oid}](${issue.commits[0].url})  \n`;
          if (issue.commits[0].warning) {
            output += `*Warning: ${issue.commits[0].warning}*  \n`
          }
          if (!issue.commits[0].team) {
            output += `*Warning: No team found for commit*  \n`;
          } else if (!issueTeams.includes(issue.commits[0].team)) {
            output += `*Warning: Commit Team **${issue.commits[0].team}** not the same as in issue*  \n`
          }
        } else {
          output += `\nAssociated Commits:\n\n`;
          issue.commits.map(commit => {
            output += `- [${commit.oid}](${commit.url}) ${(hasDifferentTeamCommits) ? '[Team: ' + commit.team + ']  \n': '  \n'}`;
            if (commit.warning) {
              output += `*Warning: ${commit.warning}*  \n`;
            }
            if (!commit.team) {
              output += `*Warning: No team found for commit*  \n`;
            } else if (!issueTeams.includes(commit.team)) {
              output += `*Warning: Commit Team **${commit.team}** not the same as in issue*  \n`
            }
          });
          output+= '\n';
        };
      }
      if (issueTeams.length === 1 && !hasDifferentTeamCommits) {
        output += `Team: ${issueTeams[0]}\n`;
      }
    });

    output += `\n## Commits not mapped to issues\n`;
    notAssignableCommits.map(commit => {
      output += `\n### ${commit.messageHeadline}

Id: [${commit.oid}](${commit.url})  \n${(commit.team ? 'Team: ' + commit.team + '\n' : '\n')}`;
    });

    fs.writeFile('./report.md', output, err => {
      if (err) {
        console.error(err)
        return
      }
    });

    console.log("Sprint-report has been successfully generated.");
  } catch (error) {
    console.error(error);
  }
})();
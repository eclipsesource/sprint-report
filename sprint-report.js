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

const startDate = '2021-12-01';
const endDate = '2021-12-31';
const startCommit = '5d9783985a270588c79304bbd5e498884c649752';
const endCommit = 'd83a127d96e3d0f3d10dabb5865bdfa29acbaff0';
const blacklistIssues = ['invalid']; // exclude issues with one of these labels
const whitelistIssues = []; // exlude all issues NOT with one of these labels - otherwise leave empty
let branch = 'main';
// CONFIG END

if (!personalAccessToken) {
  console.log("Please provide a personal Access Token to use GitHub's GraphQL endpoint.")
  return;
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
      issues(first:20) {
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

// Currently the 100 PRs before the endDate are retrieved
async function getPRs() {
  return await graphqlWithAuth(`{
  search(query: "repo:${owner}/${repoName} is:pr created:<=${endDate}", type: ISSUE, last: 100) {
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

async function getCommits() {
  let timeQuery = '';
  // Convert to Git Timestamp Format
  if (startDate) {
    const d = new Date(startDate);
    const startDateQuery = d.getFullYear() + "-" + ("0" + (d.getMonth()+1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + "T" + ("0" + (d.getHours() - 1)).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    timeQuery += `since:"${startDateQuery}"`
  }
  if (endDate) {
    const d = new Date(endDate);
    const endDateQuery = d.getFullYear() + "-" + ("0" + (d.getMonth()+1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + "T" + ("0" + (d.getHours() - 1)).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    timeQuery += `until:"${endDateQuery}"`
  }
  return await graphqlWithAuth(`{
  repository(name: "${repoName}", owner: "${owner}") {
    defaultBranchRef {
      name
    }
    ref(qualifiedName: "${branch}"){
      target {
        ... on Commit {
          history(first: 100${(timeQuery) && ',' + timeQuery}){
            totalCount
            nodes { 
              messageHeadline
              message
              oid
              abbreviatedOid
              url
              committedDate
              author {
                email
              }
            }
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
    let notAssignablePRs = []

    // Get issues for milestone
    const repo = await getIssues();
    let issues = repo.repository.milestone.issues.nodes;

    if (!branch) {
      branch = repo.repository.defaultBranchRef.name;
    }

    // Get PR's
    const query = await getPRs();
    const prs = query.search.nodes;
    
    prs.map((pr, i) => {

      if (pr.closingIssuesReferences.nodes.length > 0) {
        pr.closingIssuesReferences.nodes.map(issueRef => {
          const index = issues.map(issue => issue.number).indexOf(issueRef.number);
          if (index >= 0 && index < issues.length) {
            (issues[index].prs) ? issues[index].prs.push(pr) : issues[index].prs = [pr];
          } else {
            notAssignablePRs.unshift(i);
          }
        });

      }
      // Get issue linked to pr via branch-name
      else if (pr.headRef.name.search(/gh-?/i) !== -1) {

        const issueNumber = Number(pr.headRef.name.match(/(?:gh-?)([0-9]+)/i)[1]);
        const index = issues.map(issue => issue.number).indexOf(issueNumber);
        if (index >= 0 && index < issues.length) {
          (issues[index].prs) ? issues[index].prs.push(pr) : issues[index].prs = [pr];
        } else {
          notAssignablePRs.unshift(i);
        }
      } else {
        notAssignablePRs.unshift(i);
      }
    });
    notAssignablePRs.map(prIndex => prs.splice(prIndex, 1));

    // Get Commits
    const comQuery = await getCommits();
    let commits = comQuery.repository.ref.target.history.nodes;

    const startCommitIndex = commits.map(c => c.oid).indexOf(startCommit);
    if (startCommitIndex > 0) {
      commits.splice(startCommitIndex+1);
    }

    const endCommitIndex = commits.map(c => c.oid).indexOf(endCommit);
    if (endCommitIndex > 0) {
      commits.splice(0, endCommitIndex);
    }

    commits.map(commit => {
      const authorDomain = commit.author.email.match(/(?:@)(.*)/)[1];
      if (mailToTeamName[authorDomain]) {
        commit.team = mailToTeamName[authorDomain]
      }

      // Get linked issues via commit message
      let matches = []
      if (commit.messageHeadline.search(/(gh-)([0-9]+)/i) !== -1) {
        matches = commit.messageHeadline.match(/(gh-)([0-9]+)/ig);

      } else if (commit.message.search(/((fix|resolve|close).*(gh-)|#)([0-9]+)/i) !== -1) {
        matches = commit.message.match(/((fix|resolve|close).*(gh-)|#)([0-9]+)/ig);

      } else if (commit.message.search(/((gh-)|#)([0-9]+)/i) !== -1) {
        matches = commit.message.match(/((gh-)|#)([0-9]+)/ig);
      }

      if (matches) {
        const commitIssues = matches.map(issue => Number(issue.match(/(?:gh-|#)([0-9]+)/i)[1]));
        let hasIssue = false;
        commitIssues.map(issueNo => {
          const index = issues.map(issue => issue.number).indexOf(issueNo);
          if (index >= 0 && index < issues.length) {
            (issues[index].commits) ? issues[index].commits.push(commit) : issues[index].commits = [commit];
            hasIssue = true;
          } else {
            commit.warning = 'Commit is linking to issue not in milestone'
          }
        });
        if (!hasIssue) {
          notAssignableCommits.push(commit)
        }
        
      } else {
        commit.warning = 'Commit not linking to any issue'
        notAssignableCommits.push(commit);
      }


    });

    // Markdown Generation
    const dateFormat = {year: 'numeric', month: 'long', day: 'numeric'}


    let output = `# ${repo.repository.milestone.title} Contribution Report

Repository: [${owner}/${repoName}](${repo.repository.url})

Sprint Start (inclusive): ${new Date(startDate).toLocaleDateString("en-US",dateFormat)}  
Sprint End (inclusive): ${new Date(endDate).toLocaleDateString("en-US",dateFormat)}

Milestone: [${repo.repository.milestone.title}](${repo.repository.milestone.url})  
Number of issues: ${repo.repository.milestone.issues.totalCount}

Considered branch: ${branch}  
Start Commit (inclusive): [${commits[commits.length-1].oid}](${commits[commits.length-1].url})  
End Commit (inclusive): [${commits[0].oid}](${commits[0].url})  
Number of commits: ${commits.length}  
Number of pull requests: ${prs.length}  

## Issues
`;
    issues = issues.filter(issue => !issue.labels.nodes.some(label => blacklistIssues.includes(label.name)));
    if (whitelistIssues.length > 0) {
      issues = issues.filter(issue => issue.labels.nodes.some(label => whitelistIssues.includes(label.name)));
    }
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
          }
          const mergedAt = new Date(issue.pr.mergedAt)
          if (mergedAt > new Date(endDate) ) {
            output += `*Warning: PR <${issue.pr.url}> merged after Sprint*  \n`;
          } else if (mergedAt < new Date(startDate)) {
            output += `*Warning: PR <${issue.pr.url}> merged before Sprint*  \n`;
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
            output += `*Warning: No team found for commit*  `;
          } else if (!issueTeams.includes(issue.commits[0].team)) {
            output += `*Warning: Commit Team **${issue.commits[0].team}** not the same as in issue*  `
          }
        } else {
          output += `\nAssociated Commits:\n\n`;
          issue.commits.map(commit => {
            output += `- [${commit.oid}](${commit.url}) ${(hasDifferentTeamCommits) && '[Team: ' + commit.team + ']  \n'}`;
            if (commit.warning) {
              output += `*Warning: ${commit.warning}*  \n`;
            }
            if (!commit.team) {
              output += `*Warning: No team found for commit*  \n`;
            } else if (!issueTeams.includes(commit.team)) {
              output += `*Warning: Commit Team **${commit.team}** not the same as in issue*  \n`
            }
        })
      };
      }
      if (issueTeams.length === 1 && !hasDifferentTeamCommits) {
        output += `\nTeam: ${issueTeams[0]}\n`;
      }
    });

    output += `\n## Commits not mapped to issues\n`;
    notAssignableCommits.map(commit => {
      output += `\n### ${commit.messageHeadline}

Id: [${commit.oid}](${commit.url})  \n${(commit.team && 'Team: ' + commit.team + '\n')}`;
    });

    fs.writeFile('./report.md', output, err => {
      if (err) {
        console.error(err)
        return
      }
    });

    console.log("Sprint-report has been successfully generated.")
  } catch (error) {
    console.error(error);
  }
})();
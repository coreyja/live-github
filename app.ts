import { App as GithubApp } from "octokit";
import { App as SlackApp } from "@slack/bolt";
import dotenv from "dotenv";
import { Channel } from "@slack/web-api/dist/response/ConversationsListResponse";

dotenv.config({ path: "./.env.local" });

const repo = process.env.GITHUB_REPO;
const owner = process.env.GITHUB_OWNER;
const gitUserToSlackId = JSON.parse(process.env.GIT_USER_TO_SLACK_ID);

console.log(gitUserToSlackId);

const githubApp = new GithubApp({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_PRIVATE_KEY,
});

const slackApp = new SlackApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const getSlackChannels = async () => {
  let allChannels: Channel[] = [];

  const initChannels = await slackApp.client.conversations.list();

  allChannels = initChannels.channels;

  let nextCursor = initChannels.response_metadata.next_cursor;

  while (nextCursor) {
    const moreChannels = await slackApp.client.conversations.list({
      cursor: nextCursor,
    });

    allChannels = [...allChannels, ...moreChannels.channels];
    nextCursor = moreChannels.response_metadata.next_cursor;
  }

  return allChannels;
};

const getPrChannels = (channels: Channel[]) => {
  return channels.filter((channel) =>
    channel.name.slice(0, 3) === "pr-" ? true : false
  );
};

const main = async () => {
  await slackApp.start(3000);

  const octokit = await githubApp.getInstallationOctokit(
    parseInt(process.env.GITHUB_INSTALLATION_ID)
  );

  const allChannels = await getSlackChannels(); // fetch every channel

  const pulls = await octokit.rest.pulls.list({ owner, repo });
  const prChannels = getPrChannels(allChannels); // filter to get only channels for PRs

  const getReviewerUsernames = async (pull_number: number) => {
    const response = await octokit.rest.pulls.listRequestedReviewers({
      owner,
      repo,
      pull_number,
    });
    return response.data.users.map((user) => user.login);
  };

  const openPrNumbers = pulls.data.map((pull) => pull.number);
  const prChannelsNumber = prChannels.map((channel) =>
    parseInt(channel.name.slice(3))
  );

  //find channels to archive
  const toArchiveChannels = prChannels.filter((channel) => {
    const channelNumber = parseInt(channel.name.slice(3)),
      hasOpenPull = openPrNumbers.includes(channelNumber);

    return !hasOpenPull && !channel.is_archived ? true : false;
  });

  //archive channels with closed PRs
  toArchiveChannels.forEach((channel) => {
    slackApp.client.conversations
      .archive({ channel: channel.id })
      .then(() => console.log(`Successfully archived channel #${channel.name}`))
      .catch(() => console.log(`Failed to archived channel #${channel.name}`));
  });

  //find PRs to open channels for
  const pullsWithoutChannel = pulls.data.filter((pull) =>
    !prChannelsNumber.includes(pull.number) ? true : false
  );

  //create channels for PRs
  await pullsWithoutChannel.map(async (pull) => {
    try {
      const newChannel = await slackApp.client.conversations.create({
        name: `pr-${pull.number}`,
      });
      await slackApp.client.chat.postMessage({
        channel: newChannel.channel.id,
        text: pull.body,
      });

      const reviewerUsernames = await getReviewerUsernames(pull.number);

      const usersString = reviewerUsernames.map(reviewer => gitUserToSlackId[reviewer]).join(',')

      console.log(usersString)

      // slackApp.client.conversations.invite({
      //   channel: newChannel.channel.id,
      //   emails: [],
      //   users: "",
      // });

      // add slack link to github body
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pull.number,
        body: `https://slack.com/app_redirect?channel=${newChannel.channel.id}`,
      });

      console.log(`Successfully created channel for PR#${pull.number}`);
    } catch (_) {
      console.log(`Failed to create channel for PR#${pull.number}`);
    }
  });

  console.log(prChannelsNumber);
  console.log(pullsWithoutChannel.map((pull) => pull.number));
};

const mapGithubUserToSlackId = async () => {
  const gitUserToSlackEmail = JSON.parse(process.env.GIT_USER_TO_SLACK_EMAIL);

  const allSlackUsers = await slackApp.client.users.list();

  const emailToSlackIdMap = {};

  allSlackUsers.members.forEach((member) => {
    emailToSlackIdMap[member.profile.email] = member.id;
  });

  const gitUserToSlackId = Object.keys(gitUserToSlackEmail).map((gitUser) => {
    const email = gitUserToSlackEmail[gitUser];

    const slackId = emailToSlackIdMap[email];

    return { gitUser, slackId };
  });

  console.log(gitUserToSlackId);
};

// mapGithubUserToSlackId();
main();

import { PullRequest, User } from "@octokit/webhooks-types";
import { App as SlackApp } from "@slack/bolt";
import { Channel } from "@slack/web-api/dist/response/ConversationsListResponse";

const gitUserToSlackId = JSON.parse(process.env.GIT_USER_TO_SLACK_ID);

export const getSlackChannels = async (slackApp: SlackApp) => {
  try {
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

    console.log("✅ Success - fetched all channels");
    return allChannels;
  } catch (error) {
    console.log("❌ Error - fetched all channels");
    console.log(error);
  }
};

export const slackTextFromPullRequest = (pull: PullRequest): string => {
  return `
PR Opened! <${pull.html_url}|#${pull.number}>

PR Title: \`${pull.title}\`
PR Description:
\`\`\`
${pull.body}
\`\`\`
`;
};

export const createPullChannel = async (
  slackApp: SlackApp,
  pull: PullRequest
): Promise<Channel> => {
  try {
    const newChannel = await slackApp.client.conversations.create({
      name: `pr-${pull.number}-${process.env.GITHUB_REPO}`,
    });

    // send the body as the first message
    if (pull.body) {
      const text = slackTextFromPullRequest(pull);

      await slackApp.client.chat.postMessage({
        channel: newChannel.channel.id,
        text,
      });
    }

    // add a topic to the channel
    await slackApp.client.conversations.setTopic({
      channel: newChannel.channel.id,
      topic: pull.title,
    });

    console.log(`✅ PR#${pull.number}: Successfully created channel`);
    return newChannel.channel;
  } catch (error) {
    console.log(`❌ PR#${pull.number}: Failed to create channel`);
    console.log(error);
  }
};

export const addReviewersToChannel = async (
  slackApp: SlackApp,
  pull: PullRequest,
  channel: Channel
) => {
  const reviewersString = pull.requested_reviewers
    .map((reviewer: User) => {
      return gitUserToSlackId[reviewer.login];
    })
    .concat(gitUserToSlackId[pull.user.login])
    .join(",");

  try {
    await slackApp.client.conversations.invite({
      channel: channel.id,
      emails: [],
      users: reviewersString,
    });
    console.log(`✅ PR#${pull.number}: Successfully added ${reviewersString}`);
  } catch (error) {
    console.log(`❌ PR#${pull.number}: Failed to add ${reviewersString}`);
    console.log(error);
  }
};

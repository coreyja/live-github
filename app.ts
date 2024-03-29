import { App as GithubApp } from 'octokit'
import { App as SlackApp, KnownBlock, ExpressReceiver as SlackExpressReceiver } from '@slack/bolt'
import dotenv from 'dotenv'
import express from 'express'
import { Channel } from '@slack/web-api/dist/response/ConversationsListResponse'
import * as Sentry from '@sentry/node'
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks'
import {
  addReviewersToChannel,
  createPullChannel,
  getChannelHistory,
  getSlackChannels,
  gitUserToSlackId,
  slackTextFromPullRequest,
} from './slack'
import { PullRequest, PullRequestReviewSubmittedEvent } from '@octokit/webhooks-types'
import { minBy, sortBy, flatten } from 'lodash'
import {
  addOrUpdateManagedComment,
  addComment,
  postReviewComentReply,
  getReviewComments,
  getPullRequest,
} from './github'
import { Message } from '@slack/web-api/dist/response/ConversationsHistoryResponse'
import { channelNameFromParts, channelNameFromPull } from './util'

dotenv.config({ path: './.env.local' })

const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET!

const webhooks = new Webhooks({
  secret: githubWebhookSecret,
})

const expressApp = express()

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN })
}

expressApp.use(Sentry.Handlers.requestHandler())

const receiver = new SlackExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
})

const slackApp = new SlackApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
})

expressApp.use('/', createNodeMiddleware(webhooks))
expressApp.use('/', receiver.router)

expressApp.get('/app/openSlackChannel/v1/:repoName/:pullNumber', async (req, res) => {
  const { repoName, pullNumber } = req.params
  const channelName = channelNameFromParts(repoName, pullNumber)
  const channels = await getSlackChannels(slackApp)
  let pullChannel = channels.find(channel => channel.name === channelName)

  const pullRequest = await getPullRequest(githubApp, repoName, parseInt(pullNumber))

  if (!pullChannel) {
    pullChannel = await createPullChannel(slackApp, repoName, pullRequest)
  }

  await addReviewersToChannel(slackApp, pullRequest, pullChannel)

  const slackRedirectUrl = `https://slack.com/app_redirect?channel=${pullChannel.id}`
  res.redirect(slackRedirectUrl)
})

const githubApp = new GithubApp({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_PRIVATE_KEY!,
})

const updateSlackMessage = async (pullChannel: Channel | undefined, pull: PullRequest) => {
  if (!pullChannel?.id) return

  const me = (await slackApp.client.auth.test()).bot_id
  const messages: Message[] = await getChannelHistory(slackApp, pullChannel)
  const botComment = minBy(
    messages.filter(message => message.bot_id == me),
    (message: Message) => message.ts,
  )

  if (botComment?.ts) {
    const slackText = slackTextFromPullRequest(pull)
    await slackApp.client.chat.update({
      channel: pullChannel.id,
      ts: botComment.ts,
      text: slackText,
    })
  } else {
    console.error('Could not find our own comment, or it was missing its timestamp')
  }
}

const updateChannelMembers = async (slackApp: SlackApp, pullChannel: Channel | undefined, pull: PullRequest) => {
  if (!pullChannel?.id) return

  if (!pullChannel.is_archived) {
    await addReviewersToChannel(slackApp, pull, pullChannel)
  }
}

const updateChannelStatus = async (slackApp: SlackApp, pullChannel: Channel | undefined, pull: PullRequest) => {
  if (!pullChannel?.id) return

  if (pull.state === 'closed' && !pullChannel.is_archived) {
    console.log(`Channel ${pullChannel.name}: About to archive`)

    try {
      await slackApp.client.conversations.archive({ channel: pullChannel.id })
      console.log(`✅ Channel ${pullChannel.name}: Successfully archived`)
    } catch (error) {
      console.log(`❌ Channel ${pullChannel.name}: Failed to archive`)
      console.log(error)
    }
  }
}

const onChangePull = async (pull: PullRequest) => {
  console.log('onChangePull() called')

  const channels = await getSlackChannels(slackApp)
  const pullChannel = channels.find(channel => channel.name === channelNameFromPull(pull))

  await addOrUpdateManagedComment(githubApp, pull)

  await updateSlackMessage(pullChannel, pull)

  await updateChannelMembers(slackApp, pullChannel, pull)

  await updateChannelStatus(slackApp, pullChannel, pull)
}

webhooks.on('pull_request', async ({ payload }) => {
  await onChangePull(payload.pull_request)
})

const onSubmitPullRequestReview = async (payload: PullRequestReviewSubmittedEvent) => {
  const { review, pull_request: pull } = payload

  if (review.state === 'approved') {
    const channels = await getSlackChannels(slackApp)

    const channelName = channelNameFromPull(pull)
    const pullChannel = channels.find(channel => channel.name === channelName)

    if (pullChannel?.id) {
      try {
        await slackApp.client.chat.postMessage({
          channel: pullChannel.id,
          text: `✅ ${review.user.login} approved this PR!`,
        })

        console.log(`✅ Channel ${pullChannel.name} - Successfully sent PR approval message`)
      } catch (error) {
        console.log(`❌ Channel ${pullChannel.name} - Failed to send PR approval message`)
        console.log(error)
      }
    }
  }
}

webhooks.on('pull_request_review.submitted', async data => {
  await onSubmitPullRequestReview(data.payload)
})

webhooks.on('pull_request_review_comment.created', async ({ payload }) => {
  const { comment, pull_request } = payload
  if (comment.body.toLowerCase().includes('take this to slack')) {
    const channelName = channelNameFromPull(pull_request)

    const channels = await getSlackChannels(slackApp)

    let pullChannel = channels.find(channel => channel.name === channelName)

    if (!pullChannel) {
      pullChannel = await createPullChannel(slackApp, pull_request.base.repo.name, pull_request)
    }

    if (!pullChannel.id) throw 'The Pull Channel has no id, and thats not something we can handle'

    const allComments = await getReviewComments(githubApp, pull_request)
    const relevantComments = allComments.filter(c => c.in_reply_to_id === comment.in_reply_to_id || c.id === comment.id)
    const contextComments = sortBy(relevantComments, comment => comment.created_at).slice(-15)

    const msgContext = contextComments
      .map(comment => `Written By: ${comment.user!.login}\n${comment.body}`)
      .join('\n\n')
    const firstMessageText = `:sonic: We are moving to Slack!\n\n${msgContext}`

    const contextBlocks: KnownBlock[] = flatten(
      contextComments.map((comment): KnownBlock[] => [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: comment.body,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Written by *${comment.user!.login}* <@${gitUserToSlackId[comment.user!.login]}>`,
            },
          ],
        },
        {
          type: 'divider',
        },
      ]),
    )
    contextBlocks.pop()

    const firstBlock: KnownBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:sonic: We are moving to Slack! Here is the context from Github (most recent 15 comments)\nView the whole thread here: ${relevantComments[0].html_url}`,
      },
    }

    const blocks: KnownBlock[] = [firstBlock, ...contextBlocks]

    const firstSlackComment = await slackApp.client.chat.postMessage({
      channel: pullChannel.id,
      text: firstMessageText,
      blocks: blocks,
      unfurl_links: false,
      unfurl_media: false,
    })

    const slackUrlResponse = await slackApp.client.chat.getPermalink({
      channel: pullChannel.id,
      message_ts: firstSlackComment.ts!,
    })

    const githubCommentText = `We made a thread for you! Check it out here: ${slackUrlResponse.permalink}`

    await postReviewComentReply(githubApp, pull_request, comment.in_reply_to_id || comment.id, githubCommentText)
  }
})

slackApp.command('/add-pr-comment', async ({ command, ack, say, respond }) => {
  await ack()
  if (!command.channel_name.startsWith('pr'))
    await respond({
      response_type: 'ephemeral',
      text: 'This slash command can only be used in Pull Request Channels',
    })
  await addComment(githubApp, command, say)
})

expressApp.use(Sentry.Handlers.errorHandler())

const port = process.env.PORT || '3000'
expressApp.listen(parseInt(port))

console.log('✅ Completed all task, woohoo!!')

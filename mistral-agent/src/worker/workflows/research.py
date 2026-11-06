from pydantic import BaseModel

import mistralai.workflows as workflows
from mistralai.workflows import Depends
from mistralai.workflows.client import get_mistral_client


class ResearchInput(BaseModel):
    topic: str


@workflows.activity()
async def research_topic(topic: str, client=Depends(get_mistral_client)) -> str:
    """Ask a Mistral model for a short research report on the topic."""
    response = await client.chat.complete_async(
        model="mistral-medium-latest",
        messages=[
            {
                "role": "user",
                "content": (
                    f"Research the topic: {topic}. Write a short factual report "
                    "(about 200 words) covering: what it is, why it matters, and "
                    "two interesting facts. Plain text only."
                ),
            }
        ],
    )
    return response.choices[0].message.content


@workflows.workflow.define(
    name="topic-research",
    workflow_display_name="Topic Research",
    workflow_description="Researches a topic and returns a short report.",
)
class TopicResearchWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, input: ResearchInput) -> str:
        return await research_topic(input.topic)

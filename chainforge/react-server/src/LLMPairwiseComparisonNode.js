import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Handle } from 'reactflow';
import { Alert, Progress, Textarea } from '@mantine/core';
import { IconAlertTriangle, IconRobot, IconSearch } from "@tabler/icons-react";
import { v4 as uuid } from 'uuid';
import useStore from './store';
import BaseNode from './BaseNode';
import NodeLabel from './NodeLabelComponent';
import fetch_from_backend from './fetch_from_backend';
import { getDefaultModelSettings } from './ModelSettingSchemas';
import { LLMListContainer } from './LLMListComponent';
import PairwiseComparisonInspectorModal from './PairwiseComparisonInspectorModal';
import InspectFooter from './InspectFooter';
import { initLLMProviders } from './store';
import PairwiseComparisonInspectorDrawer from './PairwiseComparisonInspectorDrawer';

// Modeled from LLMEvalNode.js in the original repo.

// The default prompt shown in gray highlights to give people a good example of an evaluation prompt. 
const PLACEHOLDER_PROMPT = "You will be presented with two responses to a prompt and tasked with identifying which answer is better. You will reply with only the letter 'A' or the letter 'B', to indicate the better response. Do not reply with anything else.";

// The default LLM annotator is GPT-4 at temperature 0.
const DEFAULT_LLM_ITEM = (() => {
  let item = [initLLMProviders.find(i => i.base_model === 'gpt-4')]
                              .map((i) => ({key: uuid(), settings: getDefaultModelSettings(i.base_model), ...i}))[0];
  item.settings.temperature = 0.0;
  return item;
})();

const LLMPairwiseComparisonNode = ({ data, id }) => {

  const [promptText, setPromptText] = useState(data.prompt || "");
  const [status, setStatus] = useState('none');
  const alertModal = useRef(null);

  const inspectModal = useRef(null);
  const [uninspectedResponses, setUninspectedResponses] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);

  const setDataPropsForNode = useStore((state) => state.setDataPropsForNode);
  const inputEdgesForNode = useStore((state) => state.inputEdgesForNode);
  const pingOutputNodes = useStore((state) => state.pingOutputNodes);
  const bringNodeToFront = useStore((state) => state.bringNodeToFront);
  const apiKeys = useStore((state) => state.apiKeys);

  const [lastResponses, setLastResponses] = useState([]);

  const [llmScorers, setLLMScorers] = useState([data.grader || DEFAULT_LLM_ITEM]);

  // Progress when querying responses
  const [progress, setProgress] = useState(undefined);

  const handleRunClick = useCallback(() => {
    // Get the ids from the connected input nodes:
    const input_node_ids = inputEdgesForNode(id).map(e => e.source);
    if (input_node_ids.length === 0) {
        console.warn("No inputs for evaluator node.");
        return;
    }

    setStatus('loading');
    setProgress({success: 2, error: 0});

    const llm_key = llmScorers[0].key;
    const handleError = (err) => {
      setStatus('error');
      setProgress(undefined);
      alertModal.current.trigger(err?.error || err);
    };

    
    // Fetch info about the number of queries we'll need to make 
    fetch_from_backend('grabResponses', {
        responses: input_node_ids,
    }).then(function(json) {
      if (!json?.responses || json.responses.length === 0) {
        handleError('Error pulling input data for node: No input data found.');
        return;
      }

      // Create progress listener
      // TODO: inaccurate for pairwise.
      const num_resps_required = json.responses.reduce((acc, resp_obj) => acc + resp_obj.responses.length, 0);
      const progress_listener = (progress_by_llm => {
        setProgress({
          success: 100 * progress_by_llm[llm_key].success / num_resps_required,
          error: 100 * progress_by_llm[llm_key].error / num_resps_required,
        })
      });

      // Run LLM as comparator
      fetch_from_backend('compareWithLLM', {
        id: id,
        llm: llmScorers[0],
        root_prompt: promptText + '\n\n# Original Prompt\n```\n{original_prompt}\n```\n\n# System A:\n```\n{inputA}\n```\n\n# System B:\n```\n{inputB}\n```', 
        responses: input_node_ids,
        api_keys: (apiKeys ? apiKeys : {}),
        progress_listener: progress_listener,
      }).then(function(json) {
        // Check if there's an error; if so, bubble it up to user and exit:
        if (!json || json.error) {
          handleError(json?.error || 'Unknown error encountered when requesting evaluations: empty response returned.');
          return;
        } else if (json.errors && json.errors.length > 0) {
          handleError(Object.values(json.errors[0])[0]);
          return;
        }
        
        // Ping any vis + inspect nodes attached to this node to refresh their contents:
        pingOutputNodes(id);
  
        console.log(json.responses);
        setLastResponses(json.responses);
        if (!showDrawer)
          setUninspectedResponses(true);
        setStatus('ready');
        setProgress(undefined);
      }).catch(handleError);
    });
  }, [inputEdgesForNode, promptText, llmScorers, apiKeys, pingOutputNodes, setStatus, showDrawer, alertModal]);

  const handlePromptChange = useCallback((event) => {
    // Store prompt text
    setPromptText(event.target.value);
    setDataPropsForNode(id, { prompt: event.target.value });
    setStatus('warning');
  }, [setPromptText, setDataPropsForNode, setStatus, id]);

  const onLLMListItemsChange = useCallback((new_items) => {
    setLLMScorers(new_items);

    if (new_items.length > 0)
      setDataPropsForNode(id, { grader: new_items[0] });
  }, []);

  const showResponseInspector = useCallback(() => {
    if (inspectModal && inspectModal.current && lastResponses) {
      setUninspectedResponses(false);
      inspectModal.current.trigger();
    }
  }, [inspectModal, lastResponses]);

  useEffect(() => {
    if (data.refresh && data.refresh === true) {
      setDataPropsForNode(id, { refresh: false });
      setStatus('warning');
    }
  }, [data]);

  return (
    <BaseNode classNames="evaluator-node" nodeId={id}>
      <NodeLabel title={data.title || 'LLM Pairwise Comparator'} 
                  nodeId={id} 
                  icon={<IconRobot size="16px" />} 
                  status={status}
                  alertModal={alertModal}
                  handleRunClick={handleRunClick}
                  runButtonTooltip="Run comparator over inputs" />
      <PairwiseComparisonInspectorModal ref={inspectModal} jsonResponses={lastResponses} />

      <Textarea autosize
                label="Describe how to compare paired responses."
                placeholder={PLACEHOLDER_PROMPT}
                description="The text of original prompt and the responses will be pasted (with headings and back-tick (`) delimitted) directly below your rubric."
                className="prompt-field-fixed nodrag nowheel" 
                minRows="4"
                maxRows="12"
                maw='290px'
                mb='lg'
                value={promptText}
                onChange={handlePromptChange} />
      
      <LLMListContainer 
                initLLMItems={llmScorers} 
                description="Model to use as comparator:"
                modelSelectButtonText="Change"
                selectModelAction="replace"
                onAddModel={() => {}} 
                onItemsChange={onLLMListItemsChange} />
  
      {progress !== undefined ? 
          (<Progress animate={true} sections={[
              { value: progress.success, color: 'blue', tooltip: 'API call succeeded' },
              { value: progress.error, color: 'red', tooltip: 'Error collecting response' }
          ]} />)
      : <></>}

      <Alert icon={<IconAlertTriangle size="1rem" />} p='10px' radius='xs' title="Caution" color="yellow" maw='270px' mt='xs' styles={{title: {margin: '0px'}, icon: {marginRight: '4px'}, message: {fontSize: '10pt'}}}>
        AI comparisons are not 100% accurate.
      </Alert> 

      <Handle
          type="target"
          position="left"
          id="responseBatch"
          className="grouped-handle"
          style={{ top: '50%' }}
        />
      <Handle
          type="source"
          position="right"
          id="output"
          className="grouped-handle"
          style={{ top: '50%' }}
        />
      
      { lastResponses && lastResponses.length > 0 ? 
        (<InspectFooter label={<>Inspect scores&nbsp;<IconSearch size='12pt'/></>}
                        onClick={showResponseInspector}
                        showNotificationDot={uninspectedResponses} 
                        isDrawerOpen={showDrawer}
                        showDrawerButton={true} 
                        onDrawerClick={() => {
                          setShowDrawer(!showDrawer); 
                          setUninspectedResponses(false);
                          bringNodeToFront(id);
                        }}
         />) : <></>}
      
      <PairwiseComparisonInspectorDrawer jsonResponses={lastResponses} showDrawer={showDrawer} />

    </BaseNode>
  );
};

export default LLMPairwiseComparisonNode;

